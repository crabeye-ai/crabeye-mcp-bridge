/**
 * Per-RPC timeouts on user-issued calls surface to the caller via the
 * underlying `DaemonClient` rather than as a `livenessFailure` — a single
 * slow user call shouldn't trigger a respawn. Only PING-RPC timeouts
 * upgrade to `rpc_timeout` failures.
 */

import { setTimeout as delay } from "node:timers/promises";
import { EventEmitter } from "node:events";
import { ensureDaemonRunning, isDaemonReachable, type EnsureAttemptOptions } from "./bootstrap.js";
import { DaemonClient, DaemonRpcError } from "./client.js";
import { acquireLock, LockBusyError, type LockHandle } from "./lockfile.js";
import { readPidFile, terminateDaemon } from "./daemon-process.js";
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
  _ensureDaemonRunning?: (opts?: EnsureAttemptOptions) => Promise<void>;
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
  private connectedDaemonPid: number | null = null;
  private respawnPromise: Promise<void> | null = null;
  private sigkillsIssued = 0;
  private daemonRespawns = 0;

  constructor(opts: DaemonLivenessSupervisorOpts) {
    super();
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error("supervisor closed");
    const client = new DaemonClient({
      socketPath: this.opts.socketPath,
      transport: netTransport,
      rpcTimeoutMs: this.opts.rpcTimeoutMs,
      connectTimeoutMs: this.opts.rpcTimeoutMs,
      onNotification: (n) => this.opts.onNotification?.(n),
    });
    this.client = client;
    client.onClose(() => {
      if (this.client === client) this.handleSocketClose();
    });
    await client.connect();
    if (this.closed) {
      client.close();
      throw new Error("supervisor closed");
    }
    this.connectedDaemonPid = await readPidFile(this.opts.pidPath);
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

    const client = this.client;
    client.call("PING", { seq }).then(
      (result) => {
        const r = result as PingResult | undefined;
        if (r?.seq !== seq) return; // stale/duplicate
        if (typeof r.pid === "number" && this.client === client) this.connectedDaemonPid = r.pid;
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
        if (this.client !== client) return;
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
    this.respawnPromise = this.forceRespawn(ev.kind).finally(() => {
      this.respawnPromise = null;
    });
  }

  /**
   * When the connection dropped but a daemon still answers on the socket (an
   * orphaned daemon stepped down for its successor), reconnect without
   * touching the lock. Otherwise respawn lock-first: try
   * `acquireLock({ stealStale: true })`; if the previous daemon's lockholder
   * pid is dead the steal succeeds and no kill is needed. When the lock is
   * held by a live pid, SIGKILL only the daemon this supervisor was connected
   * to (its pid as reported by PONG, else the pidfile at connect time; never
   * a successor), gated by the daemon identity check against recycled pids, then
   * wait for the lock or for any daemon to answer.
   */
  private async forceRespawn(reason: LivenessFailureKind): Promise<void> {
    try {
      if (reason === "socket_close" && (await isDaemonReachable(this.opts.socketPath))) {
        await this.reconnect(reason);
        return;
      }
      let handle = await this.tryAcquireLockOnce();
      if (handle === null) {
        if (this.connectedDaemonPid !== null) {
          const result = await terminateDaemon(this.connectedDaemonPid, { graceMs: 0 });
          if (result === "terminated") this.sigkillsIssued++;
        }
        await delay(50, undefined, { ref: false });
        handle = await this.acquireLockBounded();
      }
      await handle?.release();
      if (this.closed) return;
      const ensure =
        this.opts._ensureDaemonRunning ??
        ((opts) => ensureDaemonRunning({ socketPath: this.opts.socketPath, ...opts }));
      await ensure({ freshAttempt: true });
      if (this.closed) return;
      this.daemonRespawns++;
      await this.reconnect(reason);
    } catch (err) {
      this.emit("respawnFailed", err);
    }
  }

  private async reconnect(reason: LivenessFailureKind): Promise<void> {
    this.client?.close();
    this.client = null;
    await this.connect();
    // Clear the failed flag only AFTER connect succeeds. Setting it earlier
    // would let a socket-close fired during connect() trip a re-entry into
    // failLiveness that gets masked by `respawnPromise`, leaving the
    // supervisor wedged.
    this.failed = false;
    this.emit("respawned", reason);
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
    while (handle === null && Date.now() < deadline && !this.closed) {
      if (await isDaemonReachable(this.opts.socketPath)) return null;
      await delay(100, undefined, { ref: false });
      handle = await this.tryAcquireLockOnce();
    }
    return handle;
  }
}
