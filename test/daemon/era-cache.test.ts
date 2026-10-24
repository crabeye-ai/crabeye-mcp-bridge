import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/client";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import type { StatusResult } from "../../src/daemon/protocol.js";
import { until } from "../_helpers/daemon-fixtures.js";
import {
  DISCOVER_RESULT,
  INITIALIZE_RESULT,
  LEGACY_REJECTED,
  METHOD_NOT_FOUND,
  MODERN_META,
  scriptedChild,
  type DiscoverBehaviour,
  type ScriptedChild,
} from "../_helpers/era-scripted-child.js";

const isWindows = process.platform === "win32";

const SPEC = {
  serverName: "srv",
  command: "node",
  args: [],
  resolvedEnv: {},
  cwd: "",
  clientInfo: { name: "test-bridge", version: "0" },
  clientCapabilities: {},
  protocolVersion: "2025-11-25",
};

const probe = (id: string | number) => ({ jsonrpc: "2.0", id, method: "server/discover", params: { _meta: MODERN_META } });
const modernRequest = (id: string | number) => ({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: MODERN_META } });
const initialize = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "b", version: "1" } },
});
const seenBy = (method: string) => (child: ScriptedChild) => child.received.filter((m) => m.method === method).length;
const discoversSeenBy = seenBy("server/discover");
const initializesSeenBy = seenBy("initialize");
const cancellationsSeenBy = seenBy("notifications/cancelled");

function harness() {
  const state: { dir: string; manager: ManagerDaemon | undefined; clients: DaemonClient[] } = { dir: "", manager: undefined, clients: [] };

  async function start(behaviours: DiscoverBehaviour[], opts: { childPingMs?: number; slowStart?: boolean } = {}) {
    state.dir = await mkdtemp("/tmp/cbe-era-");
    const children: ScriptedChild[] = [];
    state.manager = new ManagerDaemon({
      socketPath: join(state.dir, "m.sock"),
      pidPath: join(state.dir, "m.pid"),
      lockPath: join(state.dir, "m.lock"),
      processTrackerPath: join(state.dir, "processes.json"),
      idleMs: 60_000,
      childPingMs: opts.childPingMs ?? 0,
      transport: netTransport,
      _spawnChild: (_spec, cb) => {
        const { handle, child } = scriptedChild(behaviours[children.length] ?? behaviours.at(-1)!, opts.slowStart === true, cb);
        children.push(child);
        return handle;
      },
    });
    await state.manager.start();
    return children;
  }

  async function connection(): Promise<DaemonClient> {
    const client = new DaemonClient({ socketPath: join(state.dir, "m.sock"), transport: netTransport, rpcTimeoutMs: 2_000, connectTimeoutMs: 2_000 });
    state.clients.push(client);
    await client.connect();
    return client;
  }

  async function session() {
    const client = await connection();
    const replies: { id?: unknown; method?: string; result?: unknown; error?: unknown }[] = [];
    client.setNotificationHandler((notif) => {
      if (notif.method === "RPC") replies.push((notif.params as { payload: (typeof replies)[number] }).payload);
    });
    const sessionId = randomUUID();
    await client.call("OPEN", { sessionId, spec: SPEC });
    const send = (payload: unknown) => client.sendNotification("RPC", { sessionId, payload });
    const request = async (payload: { id: string | number }) => {
      send(payload);
      await until(() => replies.some((reply) => reply.id === payload.id), 2_000);
      return replies.find((reply) => reply.id === payload.id)!;
    };
    const connectModern = async (id: string) => {
      const answer = await request(probe(id));
      await request(modernRequest(`${id}-list`));
      return answer;
    };
    const settled = () => client.call("STATUS");
    const notifications = (method: string) => replies.filter((reply) => reply.method === method);
    return { send, request, connectModern, replies, notifications, settled, close: () => client.call("CLOSE", { sessionId }) };
  }

  const status = async () => (await (await connection()).call("STATUS")) as StatusResult;

  async function cleanup(): Promise<void> {
    for (const client of state.clients.splice(0)) client.close();
    await state.manager?.stop(0).catch(() => {});
    state.manager = undefined;
    if (state.dir) await rm(state.dir, { recursive: true, force: true });
  }

  return { start, connection, session, status, cleanup };
}

describe.skipIf(isWindows)("daemon era cache for shared STDIO children", () => {
  const { start, connection, session, status, cleanup } = harness();
  const era = async () => (await status()).children[0]!.era;

  afterEach(cleanup);

  async function restartChild(): Promise<void> {
    const { upstreamHash } = (await status()).children[0]!;
    await (await connection()).call("RESTART", { upstreamHash });
    await until(async () => (await status()).children.length === 0, 2_000);
  }

  it("confirms a modern child once a modern request follows its first probe, then answers later probes and health checks itself", async () => {
    const spawned = await start(["modern"], { childPingMs: 60_000 });
    const a = await session();
    const b = await session();

    expect(await a.connectModern("server-discover-probe-1")).toEqual({ jsonrpc: "2.0", id: "server-discover-probe-1", result: DISCOVER_RESULT });
    expect(await b.request(probe("server-discover-probe-1"))).toEqual({ jsonrpc: "2.0", id: "server-discover-probe-1", result: DISCOVER_RESULT });
    expect(await a.request(probe(7))).toEqual({ jsonrpc: "2.0", id: 7, result: DISCOVER_RESULT });

    expect(discoversSeenBy(spawned[0]!)).toBe(1);
    expect((await status()).children).toEqual([expect.objectContaining({ serverName: "srv", era: "modern" })]);
  });

  it("forwards probes until a modern request confirms the era", async () => {
    const spawned = await start(["modern"], { childPingMs: 60_000 });
    const a = await session();

    await a.request(probe("p-1"));
    await a.request(probe("p-2"));
    expect(await era()).toBe("unknown");

    await a.request(modernRequest(3));

    expect(discoversSeenBy(spawned[0]!)).toBe(2);
    expect(await era()).toBe("modern");
  });

  it("keeps forwarding a modern child's probes when the child ping is off", async () => {
    const spawned = await start(["modern"], { childPingMs: 0 });
    const a = await session();

    await a.connectModern("p-1");
    await a.request(probe(2));

    expect(discoversSeenBy(spawned[0]!)).toBe(2);
    expect(await era()).toBe("modern");
  });

  it("replays a legacy child's refusal without forwarding later probes", async () => {
    const spawned = await start(["refuses"]);
    const a = await session();
    const b = await session();

    await a.request(probe("p-1"));
    expect(await b.request(probe("p-1"))).toEqual({ jsonrpc: "2.0", id: "p-1", error: METHOD_NOT_FOUND });

    expect(discoversSeenBy(spawned[0]!)).toBe(1);
    expect(await era()).toBe("legacy");
  });

  it("marks a child that ignores the probe as legacy once the session moves on to initialize, answering later sessions from the caches", async () => {
    const spawned = await start(["ignores"]);
    const a = await session();
    a.send(probe("p-1"));
    await until(() => discoversSeenBy(spawned[0]!) === 1, 2_000);

    expect(await a.request(initialize(1))).toMatchObject({ id: 1, result: INITIALIZE_RESULT });
    const b = await session();
    expect(await b.request(probe("p-1"))).toEqual({ jsonrpc: "2.0", id: "p-1", error: METHOD_NOT_FOUND });
    expect(await b.request(initialize(1))).toMatchObject({ id: 1, result: INITIALIZE_RESULT });

    expect(discoversSeenBy(spawned[0]!)).toBe(1);
    expect(initializesSeenBy(spawned[0]!)).toBe(1);
    expect(await era()).toBe("legacy");
  });

  it("asks a slow SDK child again after it answers an abandoned probe and then pins the legacy era", async () => {
    const spawned = await start(["sdk-serve"], { childPingMs: 60_000, slowStart: true });
    const a = await session();
    a.send(probe("p-1"));
    a.send(initialize(1));
    await until(() => initializesSeenBy(spawned[0]!) === 1, 2_000);

    spawned[0]!.release();
    await until(() => a.replies.some((reply) => reply.id === 1), 2_000);
    await a.settled();

    expect(a.replies.some((reply) => reply.id === "p-1")).toBe(false);
    expect(await era()).toBe("unknown");
    const b = await session();
    expect(await b.request(probe("p-1"))).toEqual({ jsonrpc: "2.0", id: "p-1", error: METHOD_NOT_FOUND });
    expect(await b.request(initialize(1))).toMatchObject({ id: 1, result: INITIALIZE_RESULT });
    expect(spawned.map(discoversSeenBy)).toEqual([2]);
    expect(spawned.map(initializesSeenBy)).toEqual([1]);
    expect(await era()).toBe("legacy");
  });

  it("goes by a slow child's discover answer when it refuses the legacy initialize", async () => {
    const spawned = await start(["sdk-reject"], { childPingMs: 60_000, slowStart: true });
    const a = await session();
    a.send(probe("p-1"));
    a.send(initialize(1));
    await until(() => initializesSeenBy(spawned[0]!) === 1, 2_000);

    spawned[0]!.release();
    await until(() => a.replies.some((reply) => reply.id === 1), 2_000);
    await a.settled();

    expect(a.replies.find((reply) => reply.id === 1)).toMatchObject({ error: LEGACY_REJECTED });
    expect(await era()).toBe("unknown");
    const b = await session();
    expect(await b.connectModern("p-2")).toEqual({ jsonrpc: "2.0", id: "p-2", result: DISCOVER_RESULT });
    expect(await era()).toBe("modern");
  });

  it("doesn't trust a probe answered before a released bridge's initialize pinned the child legacy", async () => {
    const spawned = await start(["sdk-serve"], { childPingMs: 60_000, slowStart: true });
    const current = await session();
    const released = await session();
    current.send(probe("p-1"));
    await until(() => discoversSeenBy(spawned[0]!) === 1, 2_000);
    released.send(initialize(1));
    await until(() => initializesSeenBy(spawned[0]!) === 1, 2_000);

    spawned[0]!.release();
    await until(() => current.replies.some((reply) => reply.id === "p-1") && released.replies.some((reply) => reply.id === 1), 2_000);
    await current.request(modernRequest(2));

    expect(current.replies.find((reply) => reply.id === "p-1")).toMatchObject({ result: DISCOVER_RESULT });
    expect(await era()).toBe("unknown");
    const next = await session();
    expect(await next.request(probe("p-2"))).toEqual({ jsonrpc: "2.0", id: "p-2", error: METHOD_NOT_FOUND });
    expect(await era()).toBe("legacy");
  });

  it("doesn't store a modern verdict when a released bridge's initialize reaches an SDK child between its probe answer and the first modern request", async () => {
    await start(["sdk-serve"], { childPingMs: 60_000 });
    const current = await session();
    const released = await session();

    await current.request(probe("p-1"));
    await released.request(initialize(1));
    await current.request(modernRequest(2));

    expect(await era()).toBe("unknown");
    const next = await session();
    expect(await next.request(probe("p-2"))).toEqual({ jsonrpc: "2.0", id: "p-2", error: METHOD_NOT_FOUND });
    expect(await era()).toBe("legacy");
  });

  it("doesn't cancel a detaching session's probe, so a slow SDK child still settles modern", async () => {
    const spawned = await start(["sdk-serve"], { childPingMs: 60_000, slowStart: true });
    const current = await session();
    const leaving = await session();
    current.send(probe("p-1"));
    leaving.send(probe("p-9"));
    await until(() => discoversSeenBy(spawned[0]!) === 2, 2_000);

    await leaving.close();
    spawned[0]!.release();
    await until(() => current.replies.some((reply) => reply.id === "p-1"), 2_000);
    await current.request(modernRequest(2));

    expect(cancellationsSeenBy(spawned[0]!)).toBe(0);
    expect(await era()).toBe("modern");
  });

  it("doesn't pass a bridge's cancellation of its probe on to the child", async () => {
    const spawned = await start(["ignores"]);
    const a = await session();
    a.send(probe("p-1"));
    await until(() => discoversSeenBy(spawned[0]!) === 1, 2_000);

    a.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "p-1" } });
    await a.settled();

    expect(cancellationsSeenBy(spawned[0]!)).toBe(0);
  });

  it("marks an ignoring child legacy when a probing session's initialize is answered from the initialize cache", async () => {
    const spawned = await start(["ignores"]);
    const released = await session();
    await released.request(initialize(1));
    const current = await session();
    current.send(probe("p-1"));
    await until(() => discoversSeenBy(spawned[0]!) === 1, 2_000);

    expect(await current.request(initialize(2))).toMatchObject({ id: 2, result: INITIALIZE_RESULT });

    const next = await session();
    expect(await next.request(probe("p-2"))).toEqual({ jsonrpc: "2.0", id: "p-2", error: METHOD_NOT_FOUND });
    expect(discoversSeenBy(spawned[0]!)).toBe(1);
    expect(initializesSeenBy(spawned[0]!)).toBe(1);
  });

  it("leaves the era unknown for a session that sends initialize without probing, so a later probe still reaches the child", async () => {
    const spawned = await start(["modern"], { childPingMs: 60_000 });
    const old = await session();
    await old.request(initialize(1));
    expect(await era()).toBe("unknown");

    const current = await session();
    expect(await current.connectModern("p-1")).toMatchObject({ result: DISCOVER_RESULT });
    expect(discoversSeenBy(spawned[0]!)).toBe(1);
    expect(await era()).toBe("modern");
  });

  it("doesn't remember an unsupported-protocol-version refusal", async () => {
    const spawned = await start(["unsupported-version"]);
    const a = await session();

    await a.request(probe(1));
    await a.request(probe(2));

    expect(discoversSeenBy(spawned[0]!)).toBe(2);
    expect(await era()).toBe("unknown");
  });

  it("forwards probes that arrive together before the child has answered", async () => {
    const spawned = await start(["modern"], { childPingMs: 60_000 });
    const a = await session();
    const b = await session();

    const replies = await Promise.all([a.request(probe("p-1")), b.request(probe("p-1"))]);

    expect(replies).toEqual([expect.objectContaining({ result: DISCOVER_RESULT }), expect.objectContaining({ result: DISCOVER_RESULT })]);
    expect(discoversSeenBy(spawned[0]!)).toBe(2);
  });

  it("forgets the era when the child restarts, so the next probe reaches the new child", async () => {
    const spawned = await start(["refuses", "modern"], { childPingMs: 60_000 });
    const a = await session();
    await a.request(probe("p-1"));

    await restartChild();

    const b = await session();
    expect(await era()).toBe("unknown");
    expect(await b.connectModern("p-1")).toMatchObject({ result: DISCOVER_RESULT });
    expect(spawned.map(discoversSeenBy)).toEqual([1, 1]);
    expect(await era()).toBe("modern");
  });

  it("ignores the old child's late reply to a probe forwarded before a restart", async () => {
    const spawned = await start(["ignores", "refuses"], { childPingMs: 60_000 });
    const a = await session();
    a.send(probe("p-1"));
    await until(() => discoversSeenBy(spawned[0]!) === 1, 2_000);

    await restartChild();
    await spawned[0]!.answerLateProbe();

    const b = await session();
    expect(await era()).toBe("unknown");
    expect(await b.request(probe("p-2"))).toEqual({ jsonrpc: "2.0", id: "p-2", error: METHOD_NOT_FOUND });
    expect(spawned.map(discoversSeenBy)).toEqual([1, 1]);
  });

  it("sends each session only its own subscription's confirmation and changes, under its own id", async () => {
    const spawned = await start(["modern"]);
    const a = await session();
    const b = await session();
    const listen = { jsonrpc: "2.0", id: "listen:0", method: "subscriptions/listen", params: {} };
    const ACKNOWLEDGED = "notifications/subscriptions/acknowledged";
    const CHANGED = "notifications/tools/list_changed";

    a.send(listen);
    b.send(listen);
    for (const s of [a, b]) await until(() => s.notifications(ACKNOWLEDGED).length > 0, 2_000);
    spawned[0]!.announceToolListChange();
    for (const s of [a, b]) await until(() => s.notifications(CHANGED).length > 0, 2_000);
    await Promise.all([a.settled(), b.settled()]);

    for (const s of [a, b]) {
      for (const method of [ACKNOWLEDGED, CHANGED]) {
        expect(s.notifications(method)).toEqual([{ jsonrpc: "2.0", method, params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: "listen:0" } } }]);
      }
    }
  });

  it("drops a detached session's unanswered probe, so the child's late reply decides nothing", async () => {
    const spawned = await start(["ignores"]);
    const a = await session();
    const b = await session();
    a.send(probe("p-1"));
    await until(() => discoversSeenBy(spawned[0]!) === 1, 2_000);

    await a.close();
    await spawned[0]!.answerLateProbe();

    expect(await era()).toBe("unknown");
    b.send(probe("p-2"));
    await until(() => discoversSeenBy(spawned[0]!) === 2, 2_000);
  });
});
