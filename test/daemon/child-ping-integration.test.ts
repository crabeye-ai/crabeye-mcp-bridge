import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import type { ChildHandle } from "../../src/daemon/child-handle.js";
import type { StatusResult } from "../../src/daemon/protocol.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-cping-int-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

/**
 * The `_spawnChild` callback shape includes onMessage AND onClose. We need
 * onClose to fire when the manager kills the child, so the manager runs its
 * own teardown path. Build a full callback bag here.
 */
interface SpawnCallbacks {
  onMessage: (payload: unknown) => void;
  onClose: () => void;
  onError: (err: Error) => void;
  onStderr: (line: string) => void;
}

function makeStubChildFull(
  policy: { initialize: "respond"; ping: "respond" | "silent" },
  cb: SpawnCallbacks,
  state: { killed: boolean; pingSends: number; killCalls: number },
): ChildHandle {
  const handle = {
    startedAt: Date.now(),
    pid: 99999,
    alive: true,
    cachedInit: null as unknown,
    setCachedInit(init: unknown): void {
      handle.cachedInit = init;
    },
    send(payload: unknown): void {
      const p = payload as { id?: number; method?: string };
      if (p.method === "initialize" && policy.initialize === "respond") {
        setTimeout(() => {
          cb.onMessage({
            jsonrpc: "2.0",
            id: p.id,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: { name: "stub", version: "1.0.0" },
              capabilities: {},
            },
          });
        }, 1);
        return;
      }
      if (p.method === "ping") {
        state.pingSends += 1;
        if (policy.ping === "respond") {
          setTimeout(() => {
            cb.onMessage({ jsonrpc: "2.0", id: p.id, result: {} });
          }, 1);
        }
      }
    },
    async kill(): Promise<void> {
      if (handle.alive) {
        state.killCalls += 1;
        state.killed = true;
        handle.alive = false;
        // Mirror the real handle: kill() resolves AND triggers onClose so the
        // manager runs handleChildExit.
        queueMicrotask(() => cb.onClose());
      }
    },
  };
  return handle as unknown as ChildHandle;
}

describe.skipIf(isWindows)("ManagerDaemon — daemon-side child ping", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });
  afterEach(async () => {
    if (manager !== null) await manager.stop(0).catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  it("sends an MCP ping after initialize and treats responses as healthy", async () => {
    const state = { killed: false, pingSends: 0, killCalls: 0 };
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      // Fast cadence so the test stays under 1s.
      childPingMs: 50,
      childPingTimeoutMs: 100,
      childPingMaxConsecutiveFailures: 3,
      _spawnChild: (_spec, cb) =>
        makeStubChildFull({ initialize: "respond", ping: "respond" }, cb, state),
    });
    await manager.start();

    const client = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 2_000,
      connectTimeoutMs: 2_000,
    });

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

    await client.connect();
    await client.call("OPEN", {
      sessionId: "11111111-1111-1111-1111-111111111111",
      spec,
    });

    // Drive initialize through so the supervisor arms.
    client.sendNotification("RPC", {
      sessionId: "11111111-1111-1111-1111-111111111111",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "bridge", version: "1" },
        },
      },
    });

    // Wait long enough for a few ping cadences.
    await new Promise((r) => setTimeout(r, 250));

    expect(state.pingSends).toBeGreaterThanOrEqual(2);
    expect(state.killed).toBe(false);

    // Child still registered.
    const status = (await client.call("STATUS")) as StatusResult;
    expect(status.children).toHaveLength(1);

    client.close();
  });

  it("kills the child after maxConsecutiveFailures silent pings", async () => {
    const state = { killed: false, pingSends: 0, killCalls: 0 };
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      childPingMs: 50,
      childPingTimeoutMs: 50,
      childPingMaxConsecutiveFailures: 2,
      _spawnChild: (_spec, cb) =>
        makeStubChildFull({ initialize: "respond", ping: "silent" }, cb, state),
    });
    await manager.start();

    const client = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 2_000,
      connectTimeoutMs: 2_000,
    });
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

    await client.connect();
    await client.call("OPEN", {
      sessionId: "22222222-2222-2222-2222-222222222222",
      spec,
    });
    client.sendNotification("RPC", {
      sessionId: "22222222-2222-2222-2222-222222222222",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "bridge", version: "1" },
        },
      },
    });

    // 2 failures × (50 cadence + 50 timeout) = 200ms; pad to 400ms.
    await new Promise((r) => setTimeout(r, 400));

    expect(state.pingSends).toBeGreaterThanOrEqual(2);
    expect(state.killed).toBe(true);
    expect(state.killCalls).toBeGreaterThanOrEqual(1);

    // Telemetry attributes the kill to `wedged`.
    const status = (await client.call("STATUS")) as StatusResult;
    expect(status.telemetry.children.killedTotal.wedged).toBeGreaterThanOrEqual(1);
    expect(status.children).toHaveLength(0);

    client.close();
  });

  it("childPingMs=0 disables the supervisor (no pings sent)", async () => {
    const state = { killed: false, pingSends: 0, killCalls: 0 };
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      childPingMs: 0,
      childPingTimeoutMs: 50,
      childPingMaxConsecutiveFailures: 2,
      _spawnChild: (_spec, cb) =>
        makeStubChildFull({ initialize: "respond", ping: "silent" }, cb, state),
    });
    await manager.start();

    const client = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 2_000,
      connectTimeoutMs: 2_000,
    });
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

    await client.connect();
    await client.call("OPEN", {
      sessionId: "33333333-3333-3333-3333-333333333333",
      spec,
    });
    client.sendNotification("RPC", {
      sessionId: "33333333-3333-3333-3333-333333333333",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "bridge", version: "1" },
        },
      },
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(state.pingSends).toBe(0);
    expect(state.killed).toBe(false);

    client.close();
  });
});

