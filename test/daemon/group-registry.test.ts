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

describe.skipIf(isWindows)("ManagerDaemon — group registry", () => {
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

  it("sessions with the same spec share one child whatever sharing value an older bridge sends", async () => {
    manager = freshManager();
    await manager.start();
    const c = freshClient();
    try {
      const sharingValues = ["auto", "shared", "dedicated", "bogus", undefined];
      const sessionIds = sharingValues.map((_, i) => `${i + 1}`.repeat(8) + "-1111-1111-1111-111111111111");
      for (const [i, sharing] of sharingValues.entries()) {
        const spec = sharing === undefined ? SPEC_BASE : { ...SPEC_BASE, sharing };
        await c.call("OPEN", { sessionId: sessionIds[i], spec });
      }
      const status = (await c.call("STATUS")) as { children: Array<{ refcount: number; sessions: string[] }> };
      expect(status.children).toHaveLength(1);
      expect(status.children[0]!.refcount).toBe(sharingValues.length);
      expect(new Set(status.children[0]!.sessions)).toEqual(new Set(sessionIds));
      expect(spawnCalls).toBe(1);
    } finally {
      c.close();
    }
  });
});
