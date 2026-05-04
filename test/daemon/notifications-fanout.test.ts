import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { ChildHandle } from "../../src/daemon/child-handle.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-fanout-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

describe.skipIf(isWindows)("ManagerDaemon — notifications fanout", () => {
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

  it("broadcasts notifications/tools/list_changed to all attached sessions on same group", async () => {
    let onMsgCb: ((p: unknown) => void) | null = null;

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: (_spec, cb) => {
        onMsgCb = cb.onMessage;
        const handle = {
          startedAt: Date.now(),
          pid: 99999,
          alive: true,
          cachedInit: null,
          setCachedInit() {},
          send() {},
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

      const aNotifications: unknown[] = [];
      const bNotifications: unknown[] = [];

      cA.setNotificationHandler((notif) => {
        if (notif.method === "RPC") aNotifications.push((notif.params as { payload: unknown }).payload);
      });
      cB.setNotificationHandler((notif) => {
        if (notif.method === "RPC") bNotifications.push((notif.params as { payload: unknown }).payload);
      });

      // Fire tools/list_changed from child
      const toolsChangedPayload = {
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      };
      onMsgCb!(toolsChangedPayload);
      await new Promise((r) => setTimeout(r, 50));

      // Both A and B should receive it
      expect(aNotifications).toHaveLength(1);
      expect(bNotifications).toHaveLength(1);

      const aReceived = aNotifications[0] as { method?: string };
      const bReceived = bNotifications[0] as { method?: string };
      expect(aReceived.method).toBe("notifications/tools/list_changed");
      expect(bReceived.method).toBe("notifications/tools/list_changed");
    } finally {
      cA.close();
      cB.close();
    }
  });

  it("delivers notifications/resources/updated only to sessions subscribed to that URI", async () => {
    let onMsgCb: ((p: unknown) => void) | null = null;
    const childMessages: unknown[] = [];

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: (_spec, cb) => {
        onMsgCb = cb.onMessage;
        const handle = {
          startedAt: Date.now(),
          pid: 99999,
          alive: true,
          cachedInit: null,
          setCachedInit() {},
          send(payload: unknown) {
            childMessages.push(payload);
          },
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

      const aNotifications: unknown[] = [];
      const bNotifications: unknown[] = [];

      cA.setNotificationHandler((notif) => {
        if (notif.method === "RPC") aNotifications.push((notif.params as { payload: unknown }).payload);
      });
      cB.setNotificationHandler((notif) => {
        if (notif.method === "RPC") bNotifications.push((notif.params as { payload: unknown }).payload);
      });

      // A subscribes to mem://foo
      cA.sendNotification("RPC", {
        sessionId: sidA,
        payload: { jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: { uri: "mem://foo" } },
      });
      await new Promise((r) => setTimeout(r, 50));

      // B subscribes to mem://bar
      cB.sendNotification("RPC", {
        sessionId: sidB,
        payload: { jsonrpc: "2.0", id: 2, method: "resources/subscribe", params: { uri: "mem://bar" } },
      });
      await new Promise((r) => setTimeout(r, 50));

      // Clear the notification responses from the subscriptions
      aNotifications.length = 0;
      bNotifications.length = 0;

      // Fire resources/updated for mem://foo from child
      const fooUpdatedPayload = {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: "mem://foo" },
      };
      onMsgCb!(fooUpdatedPayload);
      await new Promise((r) => setTimeout(r, 50));

      // A should receive it (subscribed to mem://foo), B should not (subscribed to mem://bar)
      expect(aNotifications).toHaveLength(1);
      expect(bNotifications).toHaveLength(0);

      const aReceived = aNotifications[0] as { method?: unknown; params?: { uri?: unknown } };
      expect(aReceived.method).toBe("notifications/resources/updated");
      expect(aReceived.params?.uri).toBe("mem://foo");

      // Fire resources/updated for mem://bar
      const barUpdatedPayload = {
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: "mem://bar" },
      };
      onMsgCb!(barUpdatedPayload);
      await new Promise((r) => setTimeout(r, 50));

      // Now B should receive, A should still have only 1
      expect(aNotifications).toHaveLength(1);
      expect(bNotifications).toHaveLength(1);

      const bReceived = bNotifications[0] as { method?: unknown; params?: { uri?: unknown } };
      expect(bReceived.method).toBe("notifications/resources/updated");
      expect(bReceived.params?.uri).toBe("mem://bar");
    } finally {
      cA.close();
      cB.close();
    }
  });
});
