import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import type { ChildHandle } from "../../src/daemon/child-handle.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-grace-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

const SPEC = {
  serverName: "x",
  command: "node",
  args: [],
  resolvedEnv: {},
  cwd: "",
  sharing: "auto",
  clientInfo: { name: "test-bridge", version: "0.0.0" },
  clientCapabilities: {},
  protocolVersion: "2025-06-18",
} as const;

describe.skipIf(isWindows)("ManagerDaemon — idle-child grace timer", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });

  afterEach(async () => {
    if (manager !== null) {
      await manager.stop(0).catch(() => {});
    }
    await rm(paths.dir, { recursive: true, force: true });
  });

  it("child stays alive during grace window and is killed when timer expires", async () => {
    let killed = false;
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      graceMs: 100,
      killGraceMs: 50,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: () =>
        ({
          startedAt: Date.now(),
          pid: 99999,
          alive: true,
          cachedInit: null,
          setCachedInit() {},
          send() {},
          async kill() {
            killed = true;
          },
        }) as unknown as ChildHandle,
    });
    await manager.start();

    const c = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      await c.connect();
      const A = "11111111-1111-1111-1111-111111111111";
      await c.call("OPEN", { sessionId: A, spec: SPEC });
      await c.call("CLOSE", { sessionId: A });

      // Still within grace window — child must NOT be killed yet.
      await new Promise((r) => setTimeout(r, 30));
      expect(killed).toBe(false);

      // After grace window expires — child must be killed.
      await new Promise((r) => setTimeout(r, 200));
      expect(killed).toBe(true);

      // Telemetry: a single grace-killed child should be tallied under
      // killedTotal.grace=1 with no other reasons.
      const status = (await c.call("STATUS")) as import("../../src/daemon/protocol.js").StatusResult;
      expect(status.telemetry.children.spawnedTotal).toBe(1);
      expect(status.telemetry.children.killedTotal).toEqual({ grace: 1, restart: 0, fork: 0, crash: 0 });
      expect(status.telemetry.children.total).toBe(0);
      expect(status.telemetry.sessions.openedTotal).toBe(1);
      expect(status.telemetry.sessions.closedTotal).toBe(1);
    } finally {
      c.close();
    }
  });

  it("re-attach within grace cancels the timer and reuses the child", async () => {
    let spawnCount = 0;
    let killed = false;
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      graceMs: 200,
      killGraceMs: 50,
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
            killed = true;
          },
        } as unknown as ChildHandle;
      },
    });
    await manager.start();

    const c = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      await c.connect();
      const A = "11111111-1111-1111-1111-111111111111";
      const B = "22222222-2222-2222-2222-222222222222";

      // First session opens and then closes, entering the grace window.
      await c.call("OPEN", { sessionId: A, spec: SPEC });
      await c.call("CLOSE", { sessionId: A });

      // Wait a bit but still within the grace window, then re-attach.
      await new Promise((r) => setTimeout(r, 30));
      await c.call("OPEN", { sessionId: B, spec: SPEC });

      // Should have reused the existing child — only one spawn.
      expect(spawnCount).toBe(1);
      expect(killed).toBe(false);

      // Wait longer than original grace; child still alive because grace was cancelled.
      await new Promise((r) => setTimeout(r, 300));
      expect(killed).toBe(false);
      expect(spawnCount).toBe(1);
    } finally {
      c.close();
    }
  });
});
