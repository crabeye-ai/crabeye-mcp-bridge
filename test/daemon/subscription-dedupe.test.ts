import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { ChildHandle } from "../../src/daemon/child-handle.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-subdedupe-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

describe.skipIf(isWindows)("ManagerDaemon — subscribe/unsubscribe dedupe", () => {
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

  it("subscribe forwarded only on first subscriber; unsubscribe only on last", async () => {
    const childMessages: unknown[] = [];
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: (_spec, _cb) => {
        const handle = {
          startedAt: Date.now(),
          pid: 99999,
          alive: true,
          cachedInit: null,
          setCachedInit() {},
          send(payload: unknown) { childMessages.push(payload); },
          async kill() {},
        };
        return handle as unknown as ChildHandle;
      },
    });
    await manager.start();

    const spec = { serverName: "x", command: "node", args: [], resolvedEnv: {}, cwd: "" };
    const sidA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const sidB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    const cA = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    const cB = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });

    try {
      await cA.connect();
      await cA.call("OPEN", { sessionId: sidA, spec });

      await cB.connect();
      await cB.call("OPEN", { sessionId: sidB, spec });

      const aResponses: unknown[] = [];
      const bResponses: unknown[] = [];
      cA.setNotificationHandler((notif) => {
        if (notif.method === "RPC") aResponses.push((notif.params as { payload: unknown }).payload);
      });
      cB.setNotificationHandler((notif) => {
        if (notif.method === "RPC") bResponses.push((notif.params as { payload: unknown }).payload);
      });

      // A subscribes to mem://foo — should forward to child (first subscriber)
      cA.sendNotification("RPC", {
        sessionId: sidA,
        payload: { jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: { uri: "mem://foo" } },
      });
      await new Promise((r) => setTimeout(r, 50));

      const subscribesSentAfterA = childMessages.filter(
        (m) => (m as { method?: string }).method === "resources/subscribe",
      );
      expect(subscribesSentAfterA).toHaveLength(1);
      // A should get a success response
      expect(aResponses).toHaveLength(1);
      expect((aResponses[0] as { id: number; result: unknown }).id).toBe(1);

      // B also subscribes to mem://foo — should NOT forward to child (A still holds)
      cB.sendNotification("RPC", {
        sessionId: sidB,
        payload: { jsonrpc: "2.0", id: 2, method: "resources/subscribe", params: { uri: "mem://foo" } },
      });
      await new Promise((r) => setTimeout(r, 50));

      const subscribesSentAfterB = childMessages.filter(
        (m) => (m as { method?: string }).method === "resources/subscribe",
      );
      expect(subscribesSentAfterB).toHaveLength(1); // still exactly 1

      // B unsubscribes — should NOT forward (A still holds)
      cB.sendNotification("RPC", {
        sessionId: sidB,
        payload: { jsonrpc: "2.0", id: 3, method: "resources/unsubscribe", params: { uri: "mem://foo" } },
      });
      await new Promise((r) => setTimeout(r, 50));

      const unsubscribesSentAfterBUnsub = childMessages.filter(
        (m) => (m as { method?: string }).method === "resources/unsubscribe",
      );
      expect(unsubscribesSentAfterBUnsub).toHaveLength(0); // no unsubscribe forwarded yet

      // A unsubscribes — should forward to child (last subscriber)
      cA.sendNotification("RPC", {
        sessionId: sidA,
        payload: { jsonrpc: "2.0", id: 4, method: "resources/unsubscribe", params: { uri: "mem://foo" } },
      });
      await new Promise((r) => setTimeout(r, 50));

      const unsubscribesSentAfterAUnsub = childMessages.filter(
        (m) => (m as { method?: string }).method === "resources/unsubscribe",
      );
      expect(unsubscribesSentAfterAUnsub).toHaveLength(1); // now forwarded
    } finally {
      cA.close();
      cB.close();
    }
  });

  it("replies invalid_params error when subscribe is missing uri", async () => {
    const childMessages: unknown[] = [];
    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: () => ({
        startedAt: Date.now(),
        pid: 99999,
        alive: true,
        cachedInit: null,
        setCachedInit() {},
        send(p: unknown) {
          childMessages.push(p);
        },
        async kill() {},
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
      await c.call("OPEN", { sessionId: A, spec: { serverName: "x", command: "node", args: [], resolvedEnv: {}, cwd: "" } });

      const errors: unknown[] = [];
      c.setNotificationHandler((notif) => {
        if (notif.method === "RPC") {
          const pl = (notif.params as { payload: { error?: unknown } }).payload;
          if (pl.error !== undefined) errors.push(pl);
        }
      });
      c.sendNotification("RPC", {
        sessionId: A,
        payload: { jsonrpc: "2.0", id: 7, method: "resources/subscribe", params: {} },
      });
      await new Promise((r) => setTimeout(r, 30));
      expect(errors).toHaveLength(1);
      expect((errors[0] as { id: unknown }).id).toBe(7);
      expect((errors[0] as { error: { code: number } }).error.code).toBe(-32602);
      // Child must NOT have received a subscribe.
      expect(childMessages.filter((m) => (m as { method?: string }).method === "resources/subscribe")).toHaveLength(0);
    } finally {
      c.close();
    }
  });
});
