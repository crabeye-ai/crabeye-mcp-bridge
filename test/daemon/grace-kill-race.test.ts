import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-race-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

describe.skipIf(isWindows)("ManagerDaemon — grace-kill race", () => {
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

  it("attach after SIGTERM dispatched spawns a fresh child", async () => {
    let spawnCount = 0;
    let killStarted: () => void = () => {};
    const killStartedP = new Promise<void>((r) => {
      killStarted = r;
    });
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      graceMs: 30,
      killGraceMs: 200,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: () => {
        spawnCount++;
        return {
          startedAt: Date.now(),
          pid: 99999,
          alive: true,
          cachedInit: null,
          setCachedInit() {},
          send() {},
          async kill() {
            killStarted();
            await new Promise((r) => setTimeout(r, 100));
          },
        } as never;
      },
    });
    await manager.start();
    const c = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 2_000,
      connectTimeoutMs: 1_000,
    });
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
      await c.call("CLOSE", { sessionId: A });
      // Wait for grace timer (30ms) to fire → SIGTERM dispatched.
      await killStartedP;
      // Now attach a new session for the same hash. Should spawn fresh.
      await c.call("OPEN", { sessionId: B, spec });
      expect(spawnCount).toBe(2);
    } finally {
      c.close();
    }
  });
});
