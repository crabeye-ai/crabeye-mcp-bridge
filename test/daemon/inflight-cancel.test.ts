import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import type { ChildHandle } from "../../src/daemon/child-handle.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-cancel-");
  return { dir, sock: join(dir, "m.sock"), pid: join(dir, "m.pid"), lock: join(dir, "m.lock"), proc: join(dir, "processes.json") };
}

describe.skipIf(isWindows)("ManagerDaemon — in-flight cancel on detach", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;
  beforeEach(async () => { paths = await tempPaths(); await mkdir(paths.dir, { recursive: true }); manager = null; });
  afterEach(async () => { if (manager !== null) await manager.stop(0).catch(() => {}); await rm(paths.dir, { recursive: true, force: true }); });

  it("emits notifications/cancelled to child for each outstanding request when session detaches", async () => {
    const childMessages: Array<{ method?: string; params?: { requestId?: number; reason?: string } }> = [];
    manager = new ManagerDaemon({
      socketPath: paths.sock, pidPath: paths.pid, lockPath: paths.lock,
      idleMs: 60_000, transport: netTransport, processTrackerPath: paths.proc,
      _spawnChild: () => ({
        startedAt: Date.now(), pid: 99999, alive: true, cachedInit: null,
        setCachedInit() {},
        send(payload: unknown) { childMessages.push(payload as { method?: string; params?: { requestId?: number; reason?: string } }); },
        async kill() {},
      } as unknown as ChildHandle),
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
      await c.call("OPEN", { sessionId: A, spec });

      c.sendNotification("RPC", { sessionId: A, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } } });
      c.sendNotification("RPC", { sessionId: A, payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "y" } } });
      await new Promise((r) => setTimeout(r, 30));

      await c.call("CLOSE", { sessionId: A });
      await new Promise((r) => setTimeout(r, 30));

      const cancels = childMessages.filter((m) => m.method === "notifications/cancelled");
      expect(cancels).toHaveLength(2);
      const reqIds = cancels.map((c) => c.params!.requestId).sort();
      expect(reqIds).toHaveLength(2);
      expect(typeof reqIds[0]).toBe("number");
      expect(typeof reqIds[1]).toBe("number");
    } finally {
      c.close();
    }
  });
});
