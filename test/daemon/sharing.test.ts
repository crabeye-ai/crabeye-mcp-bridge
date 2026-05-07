import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { ChildHandle } from "../../src/daemon/child-handle.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-share-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

describe.skipIf(isWindows)("ManagerDaemon — hash-based sharing", () => {
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

  it("two OPENs with the same spec dedupe to a single child (refcount=2)", async () => {
    let spawnCalls = 0;
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: (_spec, cb) => {
        spawnCalls++;
        return new ChildHandle({
          command: "node",
          args: ["-e", "process.stdin.on('data', () => {})"],
          env: { PATH: process.env.PATH ?? "" },
          onMessage: cb.onMessage,
          onClose: cb.onClose,
          onError: cb.onError,
          onStderr: cb.onStderr,
        });
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
      const spec = {
        serverName: "x",
        command: "node",
        args: ["-e", "process.stdin.on('data', () => {})"],
        resolvedEnv: {},
        cwd: "",
        sharing: "auto" as const,
        clientInfo: { name: "test-bridge", version: "0.0.0" },
        clientCapabilities: {},
        protocolVersion: "2025-06-18",
      };
      await c.call("OPEN", { sessionId: "11111111-1111-1111-1111-111111111111", spec });
      await c.call("OPEN", { sessionId: "22222222-2222-2222-2222-222222222222", spec });

      const status = (await c.call("STATUS")) as { children: Array<{ refcount: number; sessions: string[]; mode: string; sharing: string; forked: boolean }> };
      expect(status.children).toHaveLength(1);
      expect(status.children[0]!.refcount).toBe(2);
      expect(new Set(status.children[0]!.sessions)).toEqual(
        new Set(["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]),
      );
      expect(status.children[0]!.mode).toBe("shared");
      expect(status.children[0]!.sharing).toBe("auto");
      expect(status.children[0]!.forked).toBe(false);
      expect(spawnCalls).toBe(1);
    } finally {
      c.close();
    }
  });

  it("two dedicated OPENs same hash spawn two children with mode=dedicated", async () => {
    let spawnCalls = 0;
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: (_spec, cb) => {
        spawnCalls++;
        return new ChildHandle({
          command: "node",
          args: ["-e", "process.stdin.on('data', () => {})"],
          env: { PATH: process.env.PATH ?? "" },
          onMessage: cb.onMessage,
          onClose: cb.onClose,
          onError: cb.onError,
          onStderr: cb.onStderr,
        });
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
      const spec = {
        serverName: "x",
        command: "node",
        args: ["-e", "process.stdin.on('data', () => {})"],
        resolvedEnv: {},
        cwd: "",
        sharing: "dedicated" as const,
        clientInfo: { name: "test-bridge", version: "0.0.0" },
        clientCapabilities: {},
        protocolVersion: "2025-06-18",
      };
      await c.call("OPEN", { sessionId: "11111111-1111-1111-1111-111111111111", spec });
      await c.call("OPEN", { sessionId: "22222222-2222-2222-2222-222222222222", spec });
      const status = (await c.call("STATUS")) as { children: Array<{ refcount: number; mode: string; sharing: string; forked: boolean }> };
      expect(status.children).toHaveLength(2);
      for (const child of status.children) {
        expect(child.refcount).toBe(1);
        expect(child.mode).toBe("dedicated");
        expect(child.sharing).toBe("dedicated");
        expect(child.forked).toBe(false);
      }
      expect(spawnCalls).toBe(2);
    } finally {
      c.close();
    }
  });
});
