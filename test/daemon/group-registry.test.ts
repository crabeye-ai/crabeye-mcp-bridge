import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { ChildHandle } from "../../src/daemon/child-handle.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-registry-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

const SPEC_BASE = {
  serverName: "x",
  command: "node",
  args: ["-e", "process.stdin.on('data', () => {})"],
  resolvedEnv: {},
  cwd: "",
  clientInfo: { name: "test-bridge", version: "0.0.0" },
  clientCapabilities: {},
  protocolVersion: "2025-06-18",
};

describe.skipIf(isWindows)("ManagerDaemon — group registry (Phase D)", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;
  let spawnCalls: number;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
    spawnCalls = 0;
  });
  afterEach(async () => {
    if (manager !== null) await manager.stop(0).catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  function freshManager(): ManagerDaemon {
    return new ManagerDaemon({
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
  }

  function freshClient(): DaemonClient {
    return new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
  }

  it("two auto OPENs same hash dedupe to one shared child (refcount=2)", async () => {
    manager = freshManager();
    await manager.start();
    const c = freshClient();
    try {
      const spec = { ...SPEC_BASE, sharing: "auto" as const };
      await c.call("OPEN", { sessionId: "11111111-1111-1111-1111-111111111111", spec });
      await c.call("OPEN", { sessionId: "22222222-2222-2222-2222-222222222222", spec });
      const status = (await c.call("STATUS")) as { children: Array<{ refcount: number; mode: string; sharing: string }> };
      expect(status.children).toHaveLength(1);
      expect(status.children[0]!.refcount).toBe(2);
      expect(status.children[0]!.mode).toBe("shared");
      expect(status.children[0]!.sharing).toBe("auto");
      expect(spawnCalls).toBe(1);
    } finally {
      c.close();
    }
  });

  it("two shared OPENs same hash dedupe to one shared child (refcount=2)", async () => {
    manager = freshManager();
    await manager.start();
    const c = freshClient();
    try {
      const spec = { ...SPEC_BASE, sharing: "shared" as const };
      await c.call("OPEN", { sessionId: "11111111-1111-1111-1111-111111111111", spec });
      await c.call("OPEN", { sessionId: "22222222-2222-2222-2222-222222222222", spec });
      const status = (await c.call("STATUS")) as { children: Array<{ refcount: number; mode: string; sharing: string }> };
      expect(status.children).toHaveLength(1);
      expect(status.children[0]!.refcount).toBe(2);
      expect(status.children[0]!.mode).toBe("shared");
      expect(status.children[0]!.sharing).toBe("shared");
      expect(spawnCalls).toBe(1);
    } finally {
      c.close();
    }
  });

  it("one auto + one shared same hash spawn TWO separate shared children", async () => {
    manager = freshManager();
    await manager.start();
    const c = freshClient();
    try {
      await c.call("OPEN", {
        sessionId: "11111111-1111-1111-1111-111111111111",
        spec: { ...SPEC_BASE, sharing: "auto" as const },
      });
      await c.call("OPEN", {
        sessionId: "22222222-2222-2222-2222-222222222222",
        spec: { ...SPEC_BASE, sharing: "shared" as const },
      });
      const status = (await c.call("STATUS")) as {
        children: Array<{ refcount: number; mode: string; sharing: string; upstreamHash: string }>;
      };
      expect(status.children).toHaveLength(2);
      const sharings = status.children.map((c) => c.sharing).sort();
      expect(sharings).toEqual(["auto", "shared"]);
      for (const child of status.children) {
        expect(child.refcount).toBe(1);
        expect(child.mode).toBe("shared");
      }
      expect(spawnCalls).toBe(2);
    } finally {
      c.close();
    }
  });

  it("two dedicated OPENs same hash spawn TWO dedicated children (refcount=1 each)", async () => {
    manager = freshManager();
    await manager.start();
    const c = freshClient();
    try {
      const spec = { ...SPEC_BASE, sharing: "dedicated" as const };
      await c.call("OPEN", { sessionId: "11111111-1111-1111-1111-111111111111", spec });
      await c.call("OPEN", { sessionId: "22222222-2222-2222-2222-222222222222", spec });
      const status = (await c.call("STATUS")) as { children: Array<{ refcount: number; mode: string; sharing: string }> };
      expect(status.children).toHaveLength(2);
      for (const child of status.children) {
        expect(child.refcount).toBe(1);
        expect(child.mode).toBe("dedicated");
        expect(child.sharing).toBe("dedicated");
      }
      expect(spawnCalls).toBe(2);
    } finally {
      c.close();
    }
  });

  it("dedicated + auto same hash spawn TWO children (one dedicated, one auto-shared)", async () => {
    manager = freshManager();
    await manager.start();
    const c = freshClient();
    try {
      await c.call("OPEN", {
        sessionId: "11111111-1111-1111-1111-111111111111",
        spec: { ...SPEC_BASE, sharing: "dedicated" as const },
      });
      await c.call("OPEN", {
        sessionId: "22222222-2222-2222-2222-222222222222",
        spec: { ...SPEC_BASE, sharing: "auto" as const },
      });
      const status = (await c.call("STATUS")) as {
        children: Array<{ refcount: number; mode: string; sharing: string }>;
      };
      expect(status.children).toHaveLength(2);
      const byMode = Object.fromEntries(status.children.map((c) => [c.sharing, c]));
      expect(byMode.dedicated).toBeDefined();
      expect(byMode.auto).toBeDefined();
      expect(byMode.dedicated!.mode).toBe("dedicated");
      expect(byMode.dedicated!.refcount).toBe(1);
      expect(byMode.auto!.mode).toBe("shared");
      expect(byMode.auto!.refcount).toBe(1);
      expect(spawnCalls).toBe(2);
    } finally {
      c.close();
    }
  });
});
