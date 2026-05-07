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
    } finally {
      c.close();
    }
  });
});
