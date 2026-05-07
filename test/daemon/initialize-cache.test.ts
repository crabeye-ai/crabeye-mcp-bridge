import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { ChildHandle } from "../../src/daemon/child-handle.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-init-");
  return { dir, sock: join(dir, "m.sock"), pid: join(dir, "m.pid"), lock: join(dir, "m.lock"), proc: join(dir, "processes.json") };
}

describe.skipIf(isWindows)("ManagerDaemon — initialize short-circuit", () => {
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

  it("first initialize forwards to child; second is short-circuited from cache", async () => {
    const childMessages: unknown[] = [];
    let childRespond: ((payload: unknown) => void) | null = null;

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: (_spec, cb) => {
        const handle = {
          startedAt: Date.now(),
          pid: 99999,
          alive: true,
          cachedInit: null as unknown,
          setCachedInit(init: unknown): void { handle.cachedInit = init; },
          send(payload: unknown): void {
            childMessages.push(payload);
            const p = payload as { id?: number; method?: string };
            if (p.method === "initialize") {
              setTimeout(() => {
                cb.onMessage({
                  jsonrpc: "2.0",
                  id: p.id,
                  result: {
                    protocolVersion: "2025-06-18",
                    serverInfo: { name: "stub", version: "1.0.0" },
                    capabilities: { tools: { listChanged: true } },
                  },
                });
              }, 5);
            }
          },
          async kill(): Promise<void> {},
        };
        childRespond = cb.onMessage;
        void childRespond;
        return handle as unknown as ChildHandle;
      },
    });
    await manager.start();

    const cA = new DaemonClient({ socketPath: paths.sock, transport: netTransport, rpcTimeoutMs: 1_000, connectTimeoutMs: 1_000 });
    const cB = new DaemonClient({ socketPath: paths.sock, transport: netTransport, rpcTimeoutMs: 1_000, connectTimeoutMs: 1_000 });
    try {
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

      // Session A
      await cA.connect();
      await cA.call("OPEN", { sessionId: "11111111-1111-1111-1111-111111111111", spec });

      const aResponses: unknown[] = [];
      // Adapt: DaemonClient.onNotification does not exist; use setNotificationHandler instead.
      cA.setNotificationHandler((notif) => {
        if (notif.method === "RPC") aResponses.push((notif.params as { payload: unknown }).payload);
      });

      cA.sendNotification("RPC", {
        sessionId: "11111111-1111-1111-1111-111111111111",
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge-A", version: "1" } },
        },
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(aResponses).toHaveLength(1);
      expect(childMessages.find((m) => (m as { method?: string }).method === "initialize")).toBeDefined();

      // Session B
      await cB.connect();
      await cB.call("OPEN", { sessionId: "22222222-2222-2222-2222-222222222222", spec });
      const bResponses: unknown[] = [];
      // Adapt: use setNotificationHandler instead of onNotification.
      cB.setNotificationHandler((notif) => {
        if (notif.method === "RPC") bResponses.push((notif.params as { payload: unknown }).payload);
      });
      const childCountBefore = childMessages.filter((m) => (m as { method?: string }).method === "initialize").length;
      cB.sendNotification("RPC", {
        sessionId: "22222222-2222-2222-2222-222222222222",
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bridge-B", version: "1" } },
        },
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(bResponses).toHaveLength(1);
      const initResp = bResponses[0] as { id: number; result: { protocolVersion: string } };
      expect(initResp.id).toBe(1);
      expect(initResp.result.protocolVersion).toBe("2025-06-18");
      const childCountAfter = childMessages.filter((m) => (m as { method?: string }).method === "initialize").length;
      expect(childCountAfter).toBe(childCountBefore); // no second initialize forwarded
    } finally {
      cA.close();
      cB.close();
    }
  });
});
