import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";

const isWindows = process.platform === "win32";
const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB_BIN = resolve(__dirname, "..", "_helpers", "stub-mcp-server-bin.mjs");

async function tempPaths(): Promise<{
  dir: string;
  sock: string;
  pid: string;
  lock: string;
  proc: string;
}> {
  const dir = await mkdtemp("/tmp/cbe-mgr-sharing-modes-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

function freshClient(paths: { sock: string }): DaemonClient {
  return new DaemonClient({
    socketPath: paths.sock,
    transport: netTransport,
    rpcTimeoutMs: 5_000,
    connectTimeoutMs: 1_000,
  });
}

function specForStub(sharing: "auto" | "shared" | "dedicated"): {
  serverName: string;
  command: string;
  args: string[];
  resolvedEnv: Record<string, string>;
  cwd: string;
  sharing: "auto" | "shared" | "dedicated";
  clientInfo: { name: string; version: string };
  clientCapabilities: Record<string, unknown>;
  protocolVersion: string;
} {
  return {
    serverName: "stub-mcp",
    command: process.execPath,
    args: [STUB_BIN],
    resolvedEnv: {},
    cwd: "",
    sharing,
    clientInfo: { name: "test-bridge", version: "0.0.0" },
    clientCapabilities: {},
    protocolVersion: "2025-06-18",
  };
}

describe.skipIf(isWindows)("sharing modes — end-to-end (Phase D)", () => {
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

  function freshManager(): ManagerDaemon {
    return new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
    });
  }

  it("auto + sampling/createMessage: fork end-to-end; subsequent tools/call works without re-OPEN", async () => {
    manager = freshManager();
    await manager.start();

    const c1 = freshClient(paths);
    const c2 = freshClient(paths);
    try {
      await c1.connect();
      await c2.connect();

      const sid1 = "11111111-1111-1111-1111-111111111111";
      const sid2 = "22222222-2222-2222-2222-222222222222";

      const c1Payloads: Array<{ id?: unknown; method?: string; result?: unknown; error?: unknown }> = [];
      const c2Payloads: Array<{ id?: unknown; method?: string; result?: unknown; error?: unknown }> = [];
      c1.setNotificationHandler((n) => {
        if (n.method === "RPC") c1Payloads.push((n.params as { payload: unknown }).payload as never);
      });
      c2.setNotificationHandler((n) => {
        if (n.method === "RPC") c2Payloads.push((n.params as { payload: unknown }).payload as never);
      });

      // OPEN both sessions with same spec.
      await c1.call("OPEN", { sessionId: sid1, spec: specForStub("auto") });
      await c2.call("OPEN", { sessionId: sid2, spec: specForStub("auto") });

      // Run initialize handshake on both.
      for (const [c, sid] of [[c1, sid1] as const, [c2, sid2] as const]) {
        c.sendNotification("RPC", {
          sessionId: sid,
          payload: {
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "1" },
            },
          },
        });
        c.sendNotification("RPC", {
          sessionId: sid,
          payload: { jsonrpc: "2.0", method: "notifications/initialized" },
        });
      }
      await new Promise((r) => setTimeout(r, 100));

      // Sanity: status shows 1 shared child.
      const status0 = (await c1.call("STATUS")) as {
        children: Array<{ refcount: number; mode: string; sharing: string }>;
      };
      expect(status0.children).toHaveLength(1);
      expect(status0.children[0]!.refcount).toBe(2);

      // Bridge B calls tools/call emit_request → triggers fork.
      c2.sendNotification("RPC", {
        sessionId: sid2,
        payload: {
          jsonrpc: "2.0", id: 999, method: "tools/call",
          params: {
            name: "emit_request",
            arguments: { method: "sampling/createMessage" },
          },
        },
      });

      // Wait for fork to complete (init replay + first attached session as originator).
      await new Promise((r) => setTimeout(r, 500));

      // Status should now reflect 2 children.
      const status1 = (await c1.call("STATUS")) as {
        children: Array<{ refcount: number; mode: string; sharing: string; forked: boolean; sessions: string[] }>;
      };
      expect(status1.children.length).toBeGreaterThanOrEqual(2);
      const forkedOldChild = status1.children.find((c) => c.forked === true);
      expect(forkedOldChild).toBeDefined();
      expect(forkedOldChild!.mode).toBe("dedicated");

      // Originating session (first attached = sid1) received the server→client request.
      const samplingRequest = c1Payloads.find(
        (p) => p.method === "sampling/createMessage",
      );
      expect(samplingRequest).toBeDefined();

      // The bridge should have ALSO received its tools/call response.
      const toolsCallResponse = c2Payloads.find((p) => p.id === 999 && p.result !== undefined);
      expect(toolsCallResponse).toBeDefined();

      // Subsequent tools/list on bridge B should land on the new child and succeed.
      c2.sendNotification("RPC", {
        sessionId: sid2,
        payload: { jsonrpc: "2.0", id: 1000, method: "tools/list" },
      });
      await new Promise((r) => setTimeout(r, 300));
      const toolsListResponse = c2Payloads.find((p) => p.id === 1000 && p.result !== undefined);
      expect(toolsListResponse).toBeDefined();
    } finally {
      c1.close();
      c2.close();
    }
  });

  it("shared + server→client request: daemon writes -32601 to child; bridge sessions undisturbed", async () => {
    manager = freshManager();
    await manager.start();

    const c1 = freshClient(paths);
    const c2 = freshClient(paths);
    try {
      await c1.connect();
      await c2.connect();

      const sid1 = "11111111-1111-1111-1111-111111111111";
      const sid2 = "22222222-2222-2222-2222-222222222222";

      const c1Payloads: Array<{ id?: unknown; method?: string }> = [];
      const c2Payloads: Array<{ id?: unknown; method?: string }> = [];
      c1.setNotificationHandler((n) => {
        if (n.method === "RPC") c1Payloads.push((n.params as { payload: unknown }).payload as never);
      });
      c2.setNotificationHandler((n) => {
        if (n.method === "RPC") c2Payloads.push((n.params as { payload: unknown }).payload as never);
      });

      await c1.call("OPEN", { sessionId: sid1, spec: specForStub("shared") });
      await c2.call("OPEN", { sessionId: sid2, spec: specForStub("shared") });

      // Initialize both.
      for (const [c, sid] of [[c1, sid1] as const, [c2, sid2] as const]) {
        c.sendNotification("RPC", {
          sessionId: sid,
          payload: {
            jsonrpc: "2.0", id: 1, method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
          },
        });
        c.sendNotification("RPC", {
          sessionId: sid,
          payload: { jsonrpc: "2.0", method: "notifications/initialized" },
        });
      }
      await new Promise((r) => setTimeout(r, 100));

      // tools/call emit_request on bridge B.
      c2.sendNotification("RPC", {
        sessionId: sid2,
        payload: {
          jsonrpc: "2.0", id: 999, method: "tools/call",
          params: { name: "emit_request", arguments: { method: "sampling/createMessage" } },
        },
      });
      await new Promise((r) => setTimeout(r, 300));

      // Both bridges should still be on the SAME shared child (no fork).
      const status = (await c1.call("STATUS")) as {
        children: Array<{ refcount: number; mode: string; sharing: string; forked: boolean }>;
      };
      expect(status.children).toHaveLength(1);
      expect(status.children[0]!.refcount).toBe(2);
      expect(status.children[0]!.mode).toBe("shared");
      expect(status.children[0]!.sharing).toBe("shared");
      expect(status.children[0]!.forked).toBe(false);

      // Neither bridge should have received the server→client request — the daemon
      // replied -32601 directly to the stub's stdin.
      expect(c1Payloads.find((p) => p.method === "sampling/createMessage")).toBeUndefined();
      expect(c2Payloads.find((p) => p.method === "sampling/createMessage")).toBeUndefined();
    } finally {
      c1.close();
      c2.close();
    }
  });

  it("dedicated cross-bridge: two OPENs same hash spawn 2 children with refcount=1 each", async () => {
    manager = freshManager();
    await manager.start();

    const c1 = freshClient(paths);
    const c2 = freshClient(paths);
    try {
      await c1.connect();
      await c2.connect();

      const sid1 = "11111111-1111-1111-1111-111111111111";
      const sid2 = "22222222-2222-2222-2222-222222222222";

      await c1.call("OPEN", { sessionId: sid1, spec: specForStub("dedicated") });
      await c2.call("OPEN", { sessionId: sid2, spec: specForStub("dedicated") });

      const status = (await c1.call("STATUS")) as {
        children: Array<{ pid: number; refcount: number; mode: string; sharing: string }>;
      };
      expect(status.children).toHaveLength(2);
      for (const child of status.children) {
        expect(child.refcount).toBe(1);
        expect(child.mode).toBe("dedicated");
        expect(child.sharing).toBe("dedicated");
      }
      expect(status.children[0]!.pid).not.toBe(status.children[1]!.pid);
    } finally {
      c1.close();
      c2.close();
    }
  });
});
