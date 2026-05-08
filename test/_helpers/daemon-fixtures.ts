/**
 * Test-only helpers for spinning up a real `ManagerDaemon` on a temp socket.
 *
 * Built for AIT-249 integration tests; mirrors the inline pattern used across
 * `test/daemon/*.test.ts` (`tempPaths()` → `new ManagerDaemon(...)` →
 * `DaemonClient`). Exposes a few extra seams (`severIncomingFrames`,
 * `kill`, `writePidfile`) that the LivenessSupervisor tests need.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DaemonClient } from "../../src/daemon/client.js";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import type { DaemonNotification, OpenParams } from "../../src/daemon/protocol.js";

export interface SpawnTestManagerOpts {
  /** Override idleMs (default 60_000). */
  idleMs?: number;
}

export interface DaemonFixture {
  dir: string;
  socketPath: string;
  pidPath: string;
  lockPath: string;
  client: DaemonClient;
  manager: ManagerDaemon;
  /**
   * Drop the manager process. Subsequent client RPCs see a closed socket.
   * Resolves once the daemon's exit promise resolves.
   */
  kill(): Promise<void>;
  /**
   * Replace the daemon side's inbound-message handler with a no-op so the
   * socket stays open but no frames are processed. Used to simulate a
   * stalled daemon.
   */
  severIncomingFrames(): void;
  /** Overwrite the pidfile with an arbitrary pid. Test-only. */
  writePidfile(pid: number): Promise<void>;
  /** Tear down: stop manager, close client, remove temp dir. */
  stop(): Promise<void>;
}

async function tempPaths(): Promise<{ dir: string; sock: string; pid: string; lock: string }> {
  // macOS UDS sun_path cap (104B) is shorter than the default $TMPDIR, so
  // sockets must live under /tmp.
  const dir = await mkdtemp("/tmp/cbe-fix-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
  };
}

export async function spawnTestManager(opts: SpawnTestManagerOpts = {}): Promise<DaemonFixture> {
  const paths = await tempPaths();
  await mkdir(paths.dir, { recursive: true });

  const manager = new ManagerDaemon({
    socketPath: paths.sock,
    pidPath: paths.pid,
    lockPath: paths.lock,
    idleMs: opts.idleMs ?? 60_000,
    transport: netTransport,
    processTrackerPath: join(paths.dir, "processes.json"),
  });
  await manager.start();

  const client = new DaemonClient({
    socketPath: paths.sock,
    transport: netTransport,
    rpcTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
  });
  await client.connect();

  let killed = false;
  const fx: DaemonFixture = {
    dir: paths.dir,
    socketPath: paths.sock,
    pidPath: paths.pid,
    lockPath: paths.lock,
    client,
    manager,
    async kill() {
      if (killed) return;
      killed = true;
      // stop(0) shuts the manager cleanly. From the client's perspective,
      // the socket goes away — equivalent to a SIGKILL for our purposes.
      await manager.stop(0).catch(() => {});
    },
    severIncomingFrames() {
      manager.severFramesForTest();
    },
    async writePidfile(pid) {
      await writeFile(paths.pid, `${pid}\n`, "utf-8");
    },
    async stop() {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      if (!killed) {
        await manager.stop(0).catch(() => {});
        killed = true;
      }
      // Manager.stop() resolves before tracker fsync may finish; retry a few
      // times if the dir is briefly non-empty.
      for (let i = 0; i < 5; i++) {
        try {
          await rm(paths.dir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      await rm(paths.dir, { recursive: true, force: true }).catch(() => {});
    },
  };
  return fx;
}

export interface OpenSessionOpts {
  /** Override session UUID. */
  sessionId?: string;
  /** Spawned-child command. */
  command?: string;
  /** Spawned-child args. */
  args?: string[];
  /** sharing override. */
  sharing?: "auto" | "shared" | "dedicated";
  /** serverName override (changes upstreamHash). */
  serverName?: string;
}

let nextSessionCounter = 0;
function nextSessionId(): string {
  // Generate a deterministic UUIDv4 shape per call, derived from an integer
  // counter so multiple sessions in the same fixture get unique ids.
  nextSessionCounter += 1;
  const n = nextSessionCounter.toString(16).padStart(8, "0");
  return `${n}-1111-1111-1111-111111111111`;
}

export class OpenSessionFixture {
  readonly sessionId: string;
  private inboundRpcHandlers: Array<(payload: unknown) => void> = [];
  private inboundFrames: unknown[] = [];
  private auxClient: DaemonClient;

  private constructor(sessionId: string, auxClient: DaemonClient) {
    this.sessionId = sessionId;
    this.auxClient = auxClient;
    auxClient.setNotificationHandler((notif) => this._onNotification(notif));
  }

  static async open(fx: DaemonFixture, opts: OpenSessionOpts = {}): Promise<OpenSessionFixture> {
    // Open a dedicated client per session so notifications are routed to it.
    const c = new DaemonClient({
      socketPath: fx.socketPath,
      transport: netTransport,
      rpcTimeoutMs: 2_000,
      connectTimeoutMs: 2_000,
    });
    await c.connect();

    const sessionId = opts.sessionId ?? nextSessionId();
    const spec: OpenParams["spec"] = {
      serverName: opts.serverName ?? "test-server",
      command: opts.command ?? "node",
      args: opts.args ?? ["-e", "process.stdin.on('data', () => {})"],
      resolvedEnv: {},
      cwd: "",
      sharing: opts.sharing ?? "dedicated",
      clientInfo: { name: "test-bridge", version: "0.0.0" },
      clientCapabilities: {},
      protocolVersion: "2025-06-18",
    };
    await c.call("OPEN", { sessionId, spec });

    const fixture = new OpenSessionFixture(sessionId, c);
    return fixture;
  }

  /** Add a handler invoked on every inbound RPC notification for THIS session. */
  onRpcNotification(handler: (payload: unknown) => void): void {
    this.inboundRpcHandlers.push(handler);
  }

  /**
   * Wait for an inbound RPC notification's `payload` to satisfy `predicate`.
   * Resolves with the matched payload; rejects on timeout.
   */
  async waitForFrame(
    predicate: (payload: unknown) => boolean,
    timeoutMs: number,
  ): Promise<unknown> {
    // Check already-buffered frames first.
    for (const p of this.inboundFrames) {
      if (predicate(p)) return p;
    }
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`waitForFrame: timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const handler = (p: unknown): void => {
        if (predicate(p)) {
          clearTimeout(timer);
          this.inboundRpcHandlers = this.inboundRpcHandlers.filter((h) => h !== handler);
          resolve(p);
        }
      };
      this.inboundRpcHandlers.push(handler);
    });
  }

  /**
   * Send a notification to the daemon over the session's owning channel.
   * Useful for staging in-flight RPCs against the session before triggering
   * a kill or other failure path.
   */
  sendNotification(method: string, params?: unknown): boolean {
    return this.auxClient.sendNotification(method, params);
  }

  /** Issue an RPC call over the session's owning channel. */
  async call(method: string, params?: unknown): Promise<unknown> {
    return this.auxClient.call(method, params);
  }

  async close(): Promise<void> {
    try {
      this.auxClient.close();
    } catch {
      /* ignore */
    }
  }

  private _onNotification(notif: DaemonNotification): void {
    if (notif.method !== "RPC") return;
    const params = notif.params as { sessionId?: string; payload?: unknown } | undefined;
    if (params === undefined || params.sessionId !== this.sessionId) return;
    const payload = params.payload;
    this.inboundFrames.push(payload);
    for (const h of this.inboundRpcHandlers) {
      try {
        h(payload);
      } catch {
        /* listeners must not throw */
      }
    }
  }
}
