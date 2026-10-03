import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import { encodeFrame, FrameDecoder } from "../../src/daemon/protocol.js";
import { DaemonStdioClient } from "../../src/upstream/daemon-stdio-client.js";
import { until } from "../_helpers/daemon-fixtures.js";

interface Connection {
  socket: Socket;
  sessionId?: string;
  rpcs: JSONRPCMessage[];
}

interface FakeDaemon {
  connections: Connection[];
  deferredOpens: Array<(reply: { result?: unknown; error?: unknown }) => void>;
  deferOpens: boolean;
  refuseStatus: boolean;
  answerPings: boolean;
  answerCalls: boolean;
  answerLists: boolean;
}

const PROGRESS = { method: "notifications/progress", params: { progressToken: "held", progress: 1 } };

type Payload = { id?: string | number; method?: string; params?: { protocolVersion?: string } };

const toolCallArg = (m: JSONRPCMessage): number | undefined => {
  const message = m as { method?: string; params?: { arguments?: { n?: number } } };
  return message.method === "tools/call" ? message.params?.arguments?.n : undefined;
};
const calls = (c: Connection) => c.rpcs.map(toolCallArg).filter((n): n is number => n !== undefined);
const isListing = (m: JSONRPCMessage) => (m as { method?: string }).method === "tools/list";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(process.platform === "win32")("a daemon-backed upstream while its daemon connection is being restored", { timeout: 20_000 }, () => {
  let dir: string;
  let sockPath: string;
  let server: Server | undefined;
  let client: DaemonStdioClient | undefined;
  let daemon: FakeDaemon;

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-hold-");
    sockPath = join(dir, "m.sock");
    daemon = { connections: [], deferredOpens: [], deferOpens: false, refuseStatus: false, answerPings: true, answerCalls: true, answerLists: true };
    server = createServer((socket: Socket) => {
      const connection: Connection = { socket, rpcs: [] };
      daemon.connections.push(connection);
      const decoder = new FrameDecoder();
      const toBridge = (payload: unknown) =>
        socket.write(encodeFrame({ method: "RPC", params: { sessionId: connection.sessionId, payload } }));
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
          const f = frame as { id?: string; method?: string; params?: { seq?: number; sessionId?: string; payload?: Payload } };
          const reply = (body: { result?: unknown; error?: unknown }) => socket.write(encodeFrame({ id: f.id, ...body }));
          if (f.method === "RPC" && f.params?.payload) {
            const payload = f.params.payload;
            connection.rpcs.push(payload as JSONRPCMessage);
            if (payload.id === undefined) continue;
            if (payload.method === "initialize") {
              toBridge({
                jsonrpc: "2.0",
                id: payload.id,
                result: { protocolVersion: payload.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } },
              });
            } else if (payload.method === "tools/list") {
              if (!daemon.answerLists) continue;
              toBridge({ jsonrpc: "2.0", id: payload.id, result: { tools: [{ name: "count", inputSchema: { type: "object" } }] } });
            } else if (payload.method !== "tools/call" || daemon.answerCalls) {
              toBridge({ jsonrpc: "2.0", id: payload.id, result: { content: [] } });
            }
          } else if (f.method === "PING") {
            if (daemon.answerPings) reply({ result: { seq: f.params?.seq } });
          } else if (f.method === "STATUS" && daemon.refuseStatus) {
            socket.destroy();
          } else if (f.method === "OPEN") {
            connection.sessionId = f.params?.sessionId;
            if (daemon.deferOpens) daemon.deferredOpens.push(reply);
            else reply({ result: { ok: true } });
          } else if (typeof f.id === "string") {
            reply({ result: { ok: true } });
          }
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(sockPath, resolve));
  });

  afterEach(async () => {
    await client?.close().catch(() => {});
    client = undefined;
    for (const c of daemon.connections) c.socket.destroy();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  async function connect(opts: { heartbeatMs?: number; ensureDaemon?: (fresh: boolean) => Promise<void> } = {}) {
    const c = (client = new DaemonStdioClient({
      name: "fake",
      config: { command: "node", args: [] } as never,
      resolvedEnv: {},
      _socketPath: sockPath,
      _ensureDaemon: (o) => opts.ensureDaemon?.(o?.freshAttempt === true) ?? Promise.resolve(),
      rpcTimeoutMs: 2_000,
      heartbeatMs: opts.heartbeatMs ?? 60_000,
    }));
    await c.connect();
    return c;
  }

  const sessionConnections = () => daemon.connections.filter((c) => c.sessionId !== undefined);
  const live = () => sessionConnections().at(-1)!;
  const call = (c: DaemonStdioClient, n: number, extra: Record<string, unknown> = {}) =>
    c.callTool({ name: "count", arguments: { n, ...extra } }) as Promise<unknown>;
  const sdk = (c: DaemonStdioClient) =>
    (c as unknown as {
      _client: {
        listTools(p: unknown, o?: { timeout: number }): Promise<unknown>;
        callTool(p: unknown, o: { timeout: number }): Promise<unknown>;
        notification(n: unknown): Promise<void>;
      };
    })._client;
  const methods = (c: Connection) =>
    c.rpcs.map((m) => {
      const n = toolCallArg(m);
      return n !== undefined ? `call ${n}` : (m as { method?: string }).method;
    });
  const listingsAfterConnect = (c: Connection) => c.rpcs.filter(isListing).length - 1;

  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
  }

  function blockedReconnect() {
    const reconnect = gate();
    const blocked = gate();
    return {
      ensureDaemon: async (fresh: boolean) => {
        if (!fresh) return;
        blocked.open();
        await reconnect.opened;
      },
      blocked: blocked.opened,
      drop: async () => {
        daemon.refuseStatus = true;
        live().socket.destroy();
        await blocked.opened;
      },
      release: () => {
        daemon.refuseStatus = false;
        reconnect.open();
      },
    };
  }

  it("holds a call made after the connection dropped and before the reconnect, and runs it once on the new connection", async () => {
    const window = blockedReconnect();
    const c = await connect({ ensureDaemon: window.ensureDaemon });
    const first = live();

    await window.drop();
    const result = call(c, 1);
    await sleep(50);
    expect(daemon.connections.flatMap(calls)).toEqual([]);
    window.release();

    await expect(result).resolves.toBeDefined();
    expect(calls(first)).toEqual([]);
    expect(daemon.connections.flatMap(calls)).toEqual([1]);
  });

  it("holds a call made while the daemon is stalled instead of writing to it", async () => {
    const window = blockedReconnect();
    const c = await connect({ heartbeatMs: 20, ensureDaemon: window.ensureDaemon });
    const stalled = live();
    daemon.answerPings = false;

    await window.blocked;
    const result = call(c, 2);
    await sleep(50);
    expect(calls(stalled)).toEqual([]);
    daemon.answerPings = true;
    window.release();

    await expect(result).resolves.toBeDefined();
    expect(calls(stalled)).toEqual([]);
    expect(calls(live())).toEqual([2]);
  });

  it("fails a call already sent when the connection dropped, and does not send it again", async () => {
    const c = await connect();
    daemon.answerCalls = false;
    const first = live();
    const inFlight = call(c, 3).catch((e: unknown) => e);
    await until(() => calls(first).length > 0);

    first.socket.destroy();
    const error = await inFlight;

    expect(String(error)).toMatch(/upstream restarted/);
    daemon.answerCalls = true;
    await call(c, 30);
    expect(daemon.connections.flatMap(calls)).toEqual([3, 30]);
  });

  it("keeps tracking a flushed call, so a second failure fails it instead of leaving it hanging", async () => {
    const window = blockedReconnect();
    const c = await connect({ ensureDaemon: window.ensureDaemon });
    daemon.answerCalls = false;

    await window.drop();
    const flushed = call(c, 4).catch((e: unknown) => e);
    window.release();
    await until(() => calls(live()).includes(4));
    live().socket.destroy();

    expect(String(await flushed)).toMatch(/upstream restarted/);
  });

  it("replays an in-flight read-only request first, then sends held messages in the order they were issued", async () => {
    const window = blockedReconnect();
    const c = await connect({ ensureDaemon: window.ensureDaemon });
    daemon.answerLists = false;
    const listing = sdk(c).listTools({});
    const first = live();
    await until(() => listingsAfterConnect(first) > 0);

    await window.drop();
    const fifth = call(c, 5);
    await sleep(20);
    await sdk(c).notification(PROGRESS);
    const sixth = call(c, 6);
    await sleep(20);
    const pending = [fifth, sixth];
    daemon.answerLists = true;
    window.release();
    await Promise.all([listing, ...pending]);

    expect(methods(live()).filter((m) => m !== "initialize" && m !== "notifications/initialized")).toEqual([
      "tools/list",
      "call 5",
      "notifications/progress",
      "call 6",
    ]);
  });

  it("never sends a held call whose caller timed out", async () => {
    const window = blockedReconnect();
    const c = await connect({ ensureDaemon: window.ensureDaemon });

    await window.drop();
    const timedOut = sdk(c).callTool({ name: "count", arguments: { n: 8 } }, { timeout: 50 }).catch((e: unknown) => e);
    expect(String(await timedOut)).toMatch(/timed out/i);
    const kept = call(c, 9);
    window.release();
    await kept;

    expect(daemon.connections.flatMap(calls)).toEqual([9]);
    expect(daemon.connections.flatMap(methods)).not.toContain("notifications/cancelled");
  });

  it("does not replay a read-only request whose caller gave up while the connection was down", async () => {
    const window = blockedReconnect();
    const c = await connect({ ensureDaemon: window.ensureDaemon });
    daemon.answerLists = false;
    const listing = sdk(c).listTools({}, { timeout: 100 }).catch((e: unknown) => e);
    const first = live();
    await until(() => listingsAfterConnect(first) > 0);

    await window.drop();
    expect(String(await listing)).toMatch(/timed out/i);
    window.release();
    await call(c, 13);

    expect(live().rpcs.filter(isListing)).toEqual([]);
  });

  it("does not replay a read-only request whose cancellation reached the old daemon", async () => {
    const window = blockedReconnect();
    const c = await connect({ ensureDaemon: window.ensureDaemon });
    daemon.answerLists = false;
    const first = live();
    const listing = sdk(c).listTools({}, { timeout: 100 }).catch((e: unknown) => e);
    expect(String(await listing)).toMatch(/timed out/i);
    await until(() => methods(first).includes("notifications/cancelled"));

    await window.drop();
    window.release();
    await call(c, 19);

    expect(live().rpcs.filter(isListing)).toEqual([]);
  });

  it("does not pass on a cancellation, made while disconnected, for a call the old daemon already had", async () => {
    const window = blockedReconnect();
    const c = await connect({ ensureDaemon: window.ensureDaemon });
    daemon.answerCalls = false;
    const first = live();
    const abandoned = sdk(c).callTool({ name: "count", arguments: { n: 31 } }, { timeout: 150 }).catch((e: unknown) => e);
    await until(() => calls(first).includes(31));

    await window.drop();
    expect(String(await abandoned)).toMatch(/timed out/i);
    window.release();
    daemon.answerCalls = true;
    await call(c, 32);

    expect(methods(live())).not.toContain("notifications/cancelled");
    expect(daemon.connections.flatMap(calls)).toEqual([31, 32]);
  });

  it("fails held calls with the respawn error and drops held notifications when the respawn itself fails", async () => {
    const respawn = gate();
    const failure = gate();
    const c = await connect({
      ensureDaemon: async (fresh) => {
        if (!fresh) return;
        respawn.open();
        await failure.opened;
        throw new Error("no daemon");
      },
    });
    const first = live();
    daemon.refuseStatus = true;
    first.socket.destroy();
    await respawn.opened;

    const held = call(c, 10).catch((e: unknown) => e);
    await sdk(c).notification(PROGRESS);
    await sleep(50);
    failure.open();

    expect(String(await held)).toMatch(/upstream restarted: no daemon/);
    expect(daemon.connections.flatMap(methods).filter((m) => m === "call 10" || m === "notifications/progress")).toEqual([]);
  });

  it("fails held calls when the re-OPEN is refused", async () => {
    const window = blockedReconnect();
    const c = await connect({ ensureDaemon: window.ensureDaemon });

    await window.drop();
    const held = call(c, 11).catch((e: unknown) => e);
    await sdk(c).notification(PROGRESS);
    daemon.deferOpens = true;
    window.release();
    await until(() => daemon.deferredOpens.length > 0);
    daemon.deferredOpens.shift()!({ error: { code: "spawn_failed", message: "spawn failed" } });

    expect(String(await held)).toMatch(/upstream restarted/);
    expect(daemon.connections.flatMap(calls)).toEqual([]);
    expect(methods(live())).not.toContain("notifications/progress");
  });

  it("rejects a held call promptly and sends nothing when the bridge closes", async () => {
    const window = blockedReconnect();
    const c = await connect({ ensureDaemon: window.ensureDaemon });

    await window.drop();
    const held = call(c, 12).catch((e: unknown) => e);
    const closing = c.close();
    client = undefined;

    expect(await held).toBeInstanceOf(Error);
    window.release();
    await closing;
    await sleep(100);
    expect(daemon.connections.flatMap(calls)).toEqual([]);
  });

  it("fails a held call too large to send without stalling the calls after it", async () => {
    const window = blockedReconnect();
    const c = await connect({ ensureDaemon: window.ensureDaemon });

    await window.drop();
    const oversized = call(c, 14, { blob: "x".repeat(17 * 1024 * 1024) }).catch((e: unknown) => e);
    const normal = call(c, 15);
    window.release();

    expect(String(await oversized)).toMatch(/rejected/);
    await expect(normal).resolves.toBeDefined();
    await expect(call(c, 16)).resolves.toBeDefined();
  });

  it("ignores a reopen that was overtaken by a later connection failure", async () => {
    const window = blockedReconnect();
    const c = await connect({ ensureDaemon: window.ensureDaemon });
    let closed = false;
    c.onStatusChange((event) => {
      if (event.current !== "connected") closed = true;
    });

    await window.drop();
    const heldAcrossBothFailures = call(c, 18);
    daemon.deferOpens = true;
    window.release();
    await until(() => daemon.deferredOpens.length === 1);
    live().socket.destroy();
    await until(() => daemon.deferredOpens.length === 2);
    daemon.deferredOpens[1]!({ result: { ok: true } });
    daemon.deferOpens = false;

    await expect(heldAcrossBothFailures).resolves.toBeDefined();
    await expect(call(c, 17)).resolves.toBeDefined();
    expect(daemon.connections.flatMap(calls).filter((n) => n === 18)).toHaveLength(1);
    await sleep(100);
    expect(closed).toBe(false);
    expect(c.status).toBe("connected");
  });

  it("does not flush held calls onto a connection that failed while its reopen was pending", async () => {
    const firstRespawn = gate();
    const secondRespawn = gate();
    const secondReached = gate();
    let respawns = 0;
    const c = await connect({
      heartbeatMs: 20,
      ensureDaemon: async (fresh) => {
        if (!fresh) return;
        respawns++;
        if (respawns === 1) await firstRespawn.opened;
        else {
          secondReached.open();
          await secondRespawn.opened;
        }
      },
    });
    daemon.refuseStatus = true;
    live().socket.destroy();
    await until(() => respawns === 1);
    const held = call(c, 20);
    await sleep(30);
    daemon.refuseStatus = false;
    daemon.deferOpens = true;
    firstRespawn.open();
    await until(() => daemon.deferredOpens.length === 1);
    const abandoned = live();
    daemon.answerPings = false;
    await secondReached.opened;

    daemon.deferredOpens.shift()!({ result: { ok: true } });
    await sleep(50);
    expect(calls(abandoned)).toEqual([]);
    daemon.answerPings = true;
    daemon.deferOpens = false;
    secondRespawn.open();

    await expect(held).resolves.toBeDefined();
    expect(calls(abandoned)).toEqual([]);
    expect(daemon.connections.flatMap(calls)).toEqual([20]);
  });

  it("rejects a call too large to send on a live connection without holding anything", async () => {
    const c = await connect();

    const oversized = call(c, 21, { blob: "x".repeat(17 * 1024 * 1024) }).catch((e: unknown) => e);
    expect(String(await oversized)).toMatch(/rejected/);

    await expect(call(c, 22)).resolves.toBeDefined();
    expect(daemon.connections.flatMap(calls)).toEqual([22]);
  });

  it("does not fail calls whose frames are only buffered because the daemon is slow to read", async () => {
    const c = await connect();
    const slow = live();
    slow.socket.pause();
    const big = "x".repeat(8_192);

    const pending = Array.from({ length: 40 }, (_, n) => call(c, n, { big }));
    await sleep(50);
    slow.socket.resume();

    await expect(Promise.all(pending)).resolves.toHaveLength(40);
    expect(calls(slow)).toHaveLength(40);
  });
});
