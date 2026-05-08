import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import type { ChildHandle } from "../../src/daemon/child-handle.js";
import {
  ERROR_CODE_AUTO_FORK_INITIALIZE_FAILED,
  ERROR_CODE_BACKPRESSURE,
  ERROR_CODE_INVALID_PARAMS,
  ERROR_CODE_INVALID_REQUEST,
  ERROR_CODE_NOT_IMPLEMENTED,
  ERROR_CODE_RPC_TIMEOUT,
  ERROR_CODE_SESSION_NOT_FOUND,
  ERROR_CODE_SPAWN_FAILED,
  ERROR_CODE_TOO_MANY_CONNECTIONS,
  ERROR_CODE_TOO_MANY_SESSIONS,
  ERROR_CODE_UNKNOWN_METHOD,
  ERROR_CODE_UPSTREAM_RESTARTED,
  type StatusResult,
} from "../../src/daemon/protocol.js";

const KNOWN_ERROR_CODES = new Set([
  ERROR_CODE_AUTO_FORK_INITIALIZE_FAILED,
  ERROR_CODE_BACKPRESSURE,
  ERROR_CODE_INVALID_PARAMS,
  ERROR_CODE_INVALID_REQUEST,
  ERROR_CODE_NOT_IMPLEMENTED,
  ERROR_CODE_RPC_TIMEOUT,
  ERROR_CODE_SESSION_NOT_FOUND,
  ERROR_CODE_SPAWN_FAILED,
  ERROR_CODE_TOO_MANY_CONNECTIONS,
  ERROR_CODE_TOO_MANY_SESSIONS,
  ERROR_CODE_UNKNOWN_METHOD,
  ERROR_CODE_UPSTREAM_RESTARTED,
]);

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-status-");
  return { dir, sock: join(dir, "m.sock"), pid: join(dir, "m.pid"), lock: join(dir, "m.lock"), proc: join(dir, "processes.json") };
}

describe.skipIf(isWindows)("ManagerDaemon — STATUS shape", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;
  beforeEach(async () => { paths = await tempPaths(); await mkdir(paths.dir, { recursive: true }); manager = null; });
  afterEach(async () => { if (manager !== null) await manager.stop(0).catch(() => {}); await rm(paths.dir, { recursive: true, force: true }); });

  it("returns per-child entries with refcount, sessions, subscriptionCount, mode, cachedInit", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock, pidPath: paths.pid, lockPath: paths.lock,
      idleMs: 60_000, transport: netTransport, processTrackerPath: paths.proc,
      _spawnChild: () => ({
        startedAt: Date.now(), pid: 99999, alive: true, cachedInit: null,
        setCachedInit() {}, send() {}, async kill() {},
      }) as unknown as ChildHandle,
    });
    await manager.start();
    const c = new DaemonClient({ socketPath: paths.sock, transport: netTransport, rpcTimeoutMs: 1_000, connectTimeoutMs: 1_000 });
    try {
      await c.connect();
      const spec = {
        serverName: "x",
        command: "node",
        args: [],
        resolvedEnv: {},
        cwd: "",
        sharing: "auto" as const,
        clientInfo: { name: "test-bridge", version: "0.0.0" },
        clientCapabilities: {},
        protocolVersion: "2025-06-18",
      };
      const A = "11111111-1111-1111-1111-111111111111";
      const B = "22222222-2222-2222-2222-222222222222";
      await c.call("OPEN", { sessionId: A, spec });
      await c.call("OPEN", { sessionId: B, spec });
      c.sendNotification("RPC", { sessionId: A, payload: { jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: { uri: "mem://foo" } } });
      await new Promise((r) => setTimeout(r, 30));

      const status = (await c.call("STATUS")) as StatusResult;
      expect(status.children).toHaveLength(1);
      const ch = status.children[0]!;
      expect(ch.refcount).toBe(2);
      expect(new Set(ch.sessions)).toEqual(new Set([A, B]));
      expect(ch.subscriptionCount).toBe(1);
      expect(ch.mode === "shared" || ch.mode === "dedicated").toBe(true);
      expect(["auto", "shared", "dedicated"]).toContain(ch.sharing);
      expect(typeof ch.forked).toBe("boolean");
      expect(ch.cachedInit).toBeNull();
      expect(typeof ch.upstreamHash).toBe("string");
      expect(typeof ch.startedAt).toBe("number");

      // Telemetry: 2 sessions opened on 1 shared child; nothing closed yet.
      expect(status.telemetry.children.total).toBe(1);
      expect(status.telemetry.children.spawnedTotal).toBe(1);
      expect(status.telemetry.children.killedTotal).toEqual({ grace: 0, restart: 0, fork: 0, crash: 0 });
      expect(status.telemetry.sessions.total).toBe(2);
      expect(status.telemetry.sessions.openedTotal).toBe(2);
      expect(status.telemetry.sessions.closedTotal).toBe(0);
      expect(status.telemetry.fork.eventsTotal).toBe(0);
      // STATUS itself is in-flight at the moment its snapshot is computed, so
      // this gauge reads 1 — the request that produced this snapshot.
      expect(status.telemetry.rpc.inFlight).toBe(1);

      await c.call("CLOSE", { sessionId: A });
      const status2 = (await c.call("STATUS")) as StatusResult;
      expect(status2.telemetry.sessions.total).toBe(1);
      expect(status2.telemetry.sessions.closedTotal).toBe(1);
    } finally {
      c.close();
    }
  });

  it("records rpc errors and unknown-method counters by code", async () => {
    manager = new ManagerDaemon({
      socketPath: paths.sock, pidPath: paths.pid, lockPath: paths.lock,
      idleMs: 60_000, transport: netTransport, processTrackerPath: paths.proc,
    });
    await manager.start();
    const c = new DaemonClient({ socketPath: paths.sock, transport: netTransport, rpcTimeoutMs: 1_000, connectTimeoutMs: 1_000 });
    try {
      await c.connect();
      // Trigger two distinct error codes.
      await c.call("BOGUS_METHOD").catch(() => {});
      await c.call("CLOSE", { sessionId: "not-a-real-session" }).catch(() => {});

      const status = (await c.call("STATUS")) as StatusResult;
      // unknown_method + invalid_params (CLOSE rejects malformed sessionId UUID)
      // OR session_not_found if it parses. Either way, error counters must be > 0.
      const totalErrors = Object.values(status.telemetry.rpc.errorsTotal).reduce((a, b) => a + b, 0);
      expect(totalErrors).toBeGreaterThanOrEqual(2);
      expect(status.telemetry.rpc.errorsTotal.unknown_method).toBeGreaterThanOrEqual(1);
      // Closed-enum invariant: every key must be a known protocol error code.
      // Guards against a future code path leaking peer-controlled or dynamic
      // strings into the per-code map (unbounded-key DoS via STATUS).
      for (const code of Object.keys(status.telemetry.rpc.errorsTotal)) {
        expect(KNOWN_ERROR_CODES.has(code)).toBe(true);
      }
    } finally {
      c.close();
    }
  });
});
