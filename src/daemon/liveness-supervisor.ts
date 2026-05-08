/**
 * Per-RPC timeouts on user-issued calls surface to the caller via the
 * underlying `DaemonClient` rather than as a `livenessFailure` — a single
 * slow user call shouldn't trigger a respawn. Only PING-RPC timeouts
 * upgrade to `rpc_timeout` failures.
 */

import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { ensureDaemonRunning } from "./bootstrap.js";
import { DaemonClient, DaemonRpcError } from "./client.js";
import { acquireLock, LockBusyError, type LockHandle } from "./lockfile.js";
import { netTransport } from "./net-transport.js";
import {
  ERROR_CODE_RPC_TIMEOUT,
  type DaemonNotification,
  type PingResult,
} from "./protocol.js";

export type LivenessFailureKind = "heartbeat_miss" | "rpc_timeout" | "socket_close";

export interface LivenessFailureEvent {
  kind: LivenessFailureKind;
  message: string;
}

export interface DaemonLivenessSupervisorOpts {
  socketPath: string;
  /** Per-RPC timeout the underlying DaemonClient applies to outbound calls. */
  rpcTimeoutMs: number;
  /** Heartbeat cadence; PING is sent every `heartbeatMs` once connected. */
  heartbeatMs: number;
  /** Lockfile path; required for force-respawn. */
  lockPath: string;
  /** Pidfile path; required for force-respawn fallback (SIGKILL via manager.pid). */
  pidPath: string;
  /** Bound on lock-wait during a two-bridge race. */
  respawnLockWaitMs: number;
  /** Inbound notification handler (passes RPC + SESSION_EVICTED frames through to the transport). */
  onNotification?: (notif: DaemonNotification) => void;
  /** Test seam: disable the force-respawn flow so we can unit-test detection alone. */
  _disableForceRespawnForTest?: boolean;
  /** Test seam: pluggable spawn-detached. Returns once the new daemon is reachable. */
  _ensureDaemonRunning?: () => Promise<void>;
}

export class DaemonLivenessSupervisor extends EventEmitter {
  private readonly opts: DaemonLivenessSupervisorOpts;
  private client: DaemonClient | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private nextSeq = 1;
  private pendingPings = new Map<number, NodeJS.Timeout>();
  private closed = false;
  private failed = false;
  private pingsSent = 0;
  private pongsReceived = 0;
  private respawnPromise: Promise<void> | null = null;
  private sigkillsIssued = 0;
  private daemonRespawns = 0;

  constructor(opts: DaemonLivenessSupervisorOpts) {
    super();
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("supervisor closed");
    this.client = new DaemonClient({
      socketPath: this.opts.socketPath,
      transport: netTransport,
      rpcTimeoutMs: this.opts.rpcTimeoutMs,
      connectTimeoutMs: this.opts.rpcTimeoutMs,
      onNotification: (n) => this.opts.onNotification?.(n),
    });
    this.client.onClose(() => this.handleSocketClose());
    await this.client.connect();
    this.startHeartbeat();
  }

  /** Forward an RPC through the wrapped client. */
  async call(method: string, params?: unknown): Promise<unknown> {
    if (this.client === null) throw new Error("supervisor not connected");
    return this.client.call(method, params);
  }

  sendNotification(method: string, params?: unknown): boolean {
    if (this.client === null) return false;
    return this.client.sendNotification(method, params);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopHeartbeat();
    this.client?.close();
    this.client = null;
    // Await any in-flight forceRespawn so its timers / spawn handles drain
    // before the caller (often a vitest worker) exits.
    if (this.respawnPromise !== null) {
      await this.respawnPromise.catch(() => { /* surfaced via respawnFailed */ });
    }
  }

  _statsForTest(): {
    pingsSent: number;
    pongsReceived: number;
    sigkillsIssued: number;
    daemonRespawns: number;
  } {
    return {
      pingsSent: this.pingsSent,
      pongsReceived: this.pongsReceived,
      sigkillsIssued: this.sigkillsIssued,
      daemonRespawns: this.daemonRespawns,
    };
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(
      () => this.sendOneHeartbeat(),
      this.opts.heartbeatMs,
    );
    if (typeof this.heartbeatTimer.unref === "function") {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const t of this.pendingPings.values()) clearTimeout(t);
    this.pendingPings.clear();
  }

  private sendOneHeartbeat(): void {
    if (this.client === null || this.failed) return;
    const seq = this.nextSeq++;
    this.pingsSent++;
    // Per-PING watchdog at heartbeatMs * 3 so a single slow PONG doesn't trip
    // respawn but a stalled daemon does.
    const watchdog = setTimeout(() => {
      this.pendingPings.delete(seq);
      this.failLiveness({
        kind: "heartbeat_miss",
        message: `PING seq=${seq} not answered in ${this.opts.heartbeatMs * 3}ms`,
      });
    }, this.opts.heartbeatMs * 3);
    if (typeof watchdog.unref === "function") watchdog.unref();
    this.pendingPings.set(seq, watchdog);

    this.client.call("PING", { seq }).then(
      (result) => {
        const r = result as PingResult | undefined;
        if (r?.seq !== seq) return; // stale/duplicate
        const t = this.pendingPings.get(seq);
        if (t !== undefined) {
          clearTimeout(t);
          this.pendingPings.delete(seq);
        }
        this.pongsReceived++;
      },
      (err) => {
        // RPC-level failure (timeout / closed). Treat per-RPC timeout as a
        // dedicated `rpc_timeout` liveness failure; socket-close is handled
        // separately via handleSocketClose.
        if (err instanceof DaemonRpcError && err.code === ERROR_CODE_RPC_TIMEOUT) {
          this.failLiveness({
            kind: "rpc_timeout",
            message: `PING seq=${seq}: ${err.message}`,
          });
        }
        // Other errors (closed connection) are surfaced via the onClose path.
      },
    );
  }

  private handleSocketClose(): void {
    if (this.closed || this.failed) return;
    this.failLiveness({ kind: "socket_close", message: "daemon connection closed" });
  }

  private failLiveness(ev: LivenessFailureEvent): void {
    if (this.failed) return;
    this.failed = true;
    this.stopHeartbeat();
    this.emit("livenessFailure", ev);
    if (this.opts._disableForceRespawnForTest) return;
    this.respawnPromise = this.forceRespawn().finally(() => {
      this.respawnPromise = null;
    });
  }

  /**
   * Lock-first respawn: try `acquireLock({ stealStale: true })` first. If the
   * previous daemon's lockholder pid is dead the steal succeeds and no kill is
   * needed. Only when the lock is held by a live pid do we read `manager.pid`
   * and SIGKILL — gated by `looksLikeOurDaemon` to mitigate the recycled-pid
   * hazard inherent in the file-based pidcheck.
   */
  private async forceRespawn(): Promise<void> {
    try {
      let handle = await this.tryAcquireLockOnce();
      if (handle === null) {
        const pid = await this.readManagerPid();
        if (pid !== null) {
          const killed = await this.killPid(pid);
          if (killed) this.sigkillsIssued++;
        }
        await delay(50, undefined, { ref: false });
        handle = await this.acquireLockBounded();
        if (handle === null) {
          throw new Error(
            "lock contention: another bridge owns the daemon respawn",
          );
        }
      }
      await handle.release();
      if (this.opts._ensureDaemonRunning !== undefined) {
        await this.opts._ensureDaemonRunning();
      } else {
        await ensureDaemonRunning({ socketPath: this.opts.socketPath });
      }
      this.daemonRespawns++;
      this.client = null;
      await this.connect();
      // Clear the failed flag only AFTER connect succeeds. Setting it earlier
      // would let a socket-close fired during connect() trip a re-entry into
      // failLiveness that gets masked by `respawning`, leaving the supervisor
      // wedged.
      this.failed = false;
      this.emit("respawned");
    } catch (err) {
      this.emit("respawnFailed", err);
    }
  }

  private async tryAcquireLockOnce(): Promise<LockHandle | null> {
    try {
      return await acquireLock(this.opts.lockPath, { stealStale: true });
    } catch (err) {
      if (err instanceof LockBusyError) return null;
      throw err;
    }
  }

  /**
   * Retry `tryAcquireLockOnce` on a 100ms backoff up to `respawnLockWaitMs`.
   * Returns null on timeout — signals the two-bridge-race losing case.
   */
  private async acquireLockBounded(): Promise<LockHandle | null> {
    const deadline = Date.now() + this.opts.respawnLockWaitMs;
    let handle = await this.tryAcquireLockOnce();
    while (handle === null && Date.now() < deadline) {
      await delay(100, undefined, { ref: false });
      handle = await this.tryAcquireLockOnce();
    }
    return handle;
  }

  private async readManagerPid(): Promise<number | null> {
    try {
      const txt = await readFile(this.opts.pidPath, "utf-8");
      const n = Number.parseInt(txt.trim(), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  private async killPid(pid: number): Promise<boolean> {
    // Defense in depth against a recycled-pid hazard: never SIGKILL self,
    // and refuse to kill a pid whose binary doesn't look like a Node daemon.
    // The lockfile-based liveness check (`process.kill(pid, 0)`) cannot
    // distinguish a recycled pid from the original daemon, so we cross-check
    // the process command line before signalling. Returns true iff the
    // signal/taskkill was actually dispatched.
    if (pid === process.pid) return false;
    if (!(await looksLikeOurDaemon(pid))) return false;
    try {
      if (process.platform === "win32") {
        const { spawn } = await import("node:child_process");
        await new Promise<void>((resolve) => {
          const c = spawn("taskkill", ["/F", "/PID", String(pid)], {
            stdio: "ignore",
          });
          c.on("exit", () => resolve());
          c.on("error", () => resolve());
        });
      } else {
        process.kill(pid, "SIGKILL");
      }
      return true;
    } catch {
      // pid may have died between check and kill; the second lock attempt
      // covers this.
      return false;
    }
  }
}

/**
 * Heuristic: verify pid's command-line argv looks like a Node process invoking
 * a `daemon` subcommand. Returns false on any error so we fail closed.
 *
 * Linux: read `/proc/<pid>/cmdline` (NUL-separated argv).
 * Other platforms (macOS, BSD): shell out to `ps -p <pid> -o args=`.
 */
async function looksLikeOurDaemon(pid: number): Promise<boolean> {
  try {
    let cmdline: string;
    if (process.platform === "linux") {
      cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf-8")).replace(/\0/g, " ");
    } else {
      const { spawn } = await import("node:child_process");
      cmdline = await new Promise<string>((resolve, reject) => {
        const c = spawn("ps", ["-p", String(pid), "-o", "args="], { stdio: ["ignore", "pipe", "ignore"] });
        let buf = "";
        c.stdout.on("data", (d: Buffer) => { buf += d.toString("utf-8"); });
        c.on("exit", () => resolve(buf));
        c.on("error", reject);
      });
    }
    const lower = cmdline.toLowerCase();
    return /\bnode\b/.test(lower) && /\bdaemon\b/.test(lower);
  } catch {
    return false;
  }
}

