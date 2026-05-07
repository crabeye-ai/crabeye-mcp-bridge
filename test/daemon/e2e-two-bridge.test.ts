import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import type { DaemonNotification } from "../../src/daemon/protocol.js";

const isWindows = process.platform === "win32";

// Stub MCP server that responds to initialize and tools/call via JSON-RPC over STDIO.
const STUB_MCP = `
const { stdin, stdout } = process;
let buf = "";
stdin.setEncoding("utf-8");
stdin.on("data", (chunk) => {
  buf += chunk;
  let nl = buf.indexOf("\\n");
  while (nl !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim().length > 0) {
      const req = JSON.parse(line);
      if (req.method === "initialize") {
        const resp = { jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "stub", version: "1.0.0" }, capabilities: { tools: { listChanged: true } } } };
        stdout.write(JSON.stringify(resp) + "\\n");
      } else if (req.method === "tools/call") {
        const resp = { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "ok" }] } };
        stdout.write(JSON.stringify(resp) + "\\n");
      }
    }
    nl = buf.indexOf("\\n");
  }
});
`;

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-e2e-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
    stub: join(dir, "stub.cjs"),
  };
}

/**
 * Poll a queue for a payload matching `pred`, timing out after `timeoutMs`.
 * Removes the matched element from the queue and returns it.
 */
async function awaitMatch(
  queue: unknown[],
  pred: (p: unknown) => boolean,
  timeoutMs = 3_000,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = 0; i < queue.length; i++) {
      if (pred(queue[i])) {
        const [match] = queue.splice(i, 1);
        return match;
      }
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for match (queue had ${queue.length} item(s): ${JSON.stringify(queue.slice(0, 3))})`,
  );
}

describe.skipIf(isWindows)("e2e — two bridges share one daemon child", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.stub, STUB_MCP, "utf-8");
    manager = null;
  });

  afterEach(async () => {
    if (manager !== null) await manager.stop(0).catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  it(
    "two OPENs with same spec yield single STATUS child and both can call tools",
    async () => {
      // Real spawn — no _spawnChild injection.
      manager = new ManagerDaemon({
        socketPath: paths.sock,
        pidPath: paths.pid,
        lockPath: paths.lock,
        idleMs: 60_000,
        graceMs: 60_000,
        killGraceMs: 2_000,
        transport: netTransport,
        processTrackerPath: paths.proc,
      });
      await manager.start();

      const cA = new DaemonClient({
        socketPath: paths.sock,
        transport: netTransport,
        rpcTimeoutMs: 5_000,
        connectTimeoutMs: 2_000,
      });
      const cB = new DaemonClient({
        socketPath: paths.sock,
        transport: netTransport,
        rpcTimeoutMs: 5_000,
        connectTimeoutMs: 2_000,
      });

      // Per-client notification queues: only RPC payloads are enqueued.
      const aQueue: unknown[] = [];
      const bQueue: unknown[] = [];

      cA.setNotificationHandler((n: DaemonNotification) => {
        if (n.method === "RPC") {
          aQueue.push((n.params as { payload: unknown }).payload);
        }
      });
      cB.setNotificationHandler((n: DaemonNotification) => {
        if (n.method === "RPC") {
          bQueue.push((n.params as { payload: unknown }).payload);
        }
      });

      try {
        await cA.connect();
        await cB.connect();

        const spec = {
          serverName: "stub",
          command: "node",
          args: [paths.stub],
          resolvedEnv: {},
          cwd: "",
          sharing: "auto" as const,
          clientInfo: { name: "test-bridge", version: "0.0.0" },
          clientCapabilities: {},
          protocolVersion: "2025-06-18",
        };
        const A = "11111111-1111-1111-1111-111111111111";
        const B = "22222222-2222-2222-2222-222222222222";

        // --- Step 3: Both clients OPEN with the same spec ---
        await cA.call("OPEN", { sessionId: A, spec });
        await cB.call("OPEN", { sessionId: B, spec });

        // --- Step 4: cA sends initialize (id=1), await real child response ---
        cA.sendNotification("RPC", {
          sessionId: A,
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "A", version: "1" },
            },
          },
        });
        const aInit = (await awaitMatch(
          aQueue,
          (p) => {
            const pl = p as { id?: unknown; result?: unknown };
            return pl.id === 1 && pl.result !== undefined;
          },
          5_000,
        )) as { id: number; result: unknown };
        expect(aInit.id).toBe(1);
        expect(aInit.result).toBeDefined();

        // --- Step 5: cB sends initialize (id=1), await cached response ---
        cB.sendNotification("RPC", {
          sessionId: B,
          payload: {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "B", version: "1" },
            },
          },
        });
        const bInit = (await awaitMatch(
          bQueue,
          (p) => {
            const pl = p as { id?: unknown; result?: unknown };
            return pl.id === 1 && pl.result !== undefined;
          },
          5_000,
        )) as { id: number; result: unknown };
        expect(bInit.id).toBe(1);
        expect(bInit.result).toBeDefined();

        // --- Step 6: STATUS — exactly one child, refcount 2 ---
        const status = (await cA.call("STATUS")) as {
          children: Array<{ refcount: number; sessions: string[] }>;
        };
        expect(status.children).toHaveLength(1);
        expect(status.children[0]!.refcount).toBe(2);

        // --- Steps 7-8: concurrent tools/call from both sessions (id=2) ---
        // Send both before awaiting either to exercise concurrent rewriting.
        cA.sendNotification("RPC", {
          sessionId: A,
          payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x" } },
        });
        cB.sendNotification("RPC", {
          sessionId: B,
          payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "y" } },
        });

        const [aTool, bTool] = await Promise.all([
          awaitMatch(
            aQueue,
            (p) => {
              const pl = p as { id?: unknown; result?: unknown };
              return pl.id === 2 && pl.result !== undefined;
            },
            5_000,
          ) as Promise<{ id: number; result: unknown }>,
          awaitMatch(
            bQueue,
            (p) => {
              const pl = p as { id?: unknown; result?: unknown };
              return pl.id === 2 && pl.result !== undefined;
            },
            5_000,
          ) as Promise<{ id: number; result: unknown }>,
        ]);

        // Each session sees its own original id (2) round-tripped back.
        expect((aTool as { id: number }).id).toBe(2);
        expect((bTool as { id: number }).id).toBe(2);
      } finally {
        cA.close();
        cB.close();
      }
    },
    15_000,
  );
});
