import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  ProtocolErrorCode,
} from "@modelcontextprotocol/client";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import type { StatusResult } from "../../src/daemon/protocol.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { MODERN_STUB_DISCOVER_LOG_ENV, MODERN_STUB_START_DELAY_ENV } from "../_helpers/stub-stdio-server.js";

const isWindows = process.platform === "win32";
const ENVELOPE = {
  [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
  [CLIENT_INFO_META_KEY]: { name: "era-test", version: "0" },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};
const probe = (id: string) => ({ jsonrpc: "2.0", id, method: "server/discover", params: { _meta: ENVELOPE } });
const modernRequest = (id: string) => ({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: ENVELOPE } });
const initialize = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "released-bridge", version: "1.3.0" } },
});

interface Reply {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code?: number };
}

describe.skipIf(isWindows)("daemon era cache against a real SDK v2 child", { timeout: 30_000 }, () => {
  let server: string;
  let dir = "";
  let manager: ManagerDaemon | undefined;
  const clients: DaemonClient[] = [];

  beforeAll(async () => {
    server = await bundleForSubprocess("test/_helpers/subprocess/modern-stdio-server.ts", "modern-stdio-server");
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await manager?.stop(0).catch(() => {});
    manager = undefined;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function start(opts: { childPingMs?: number; startDelayMs?: number } = {}) {
    dir = await mkdtemp("/tmp/cbe-era-sdk-");
    const discoverLog = join(dir, "discovers.log");
    await writeFile(discoverLog, "");
    manager = new ManagerDaemon({
      socketPath: join(dir, "m.sock"),
      pidPath: join(dir, "m.pid"),
      lockPath: join(dir, "m.lock"),
      processTrackerPath: join(dir, "processes.json"),
      idleMs: 60_000,
      killGraceMs: 200,
      childPingMs: opts.childPingMs ?? 60_000,
      transport: netTransport,
    });
    await manager.start();
    const spec = {
      serverName: "modern",
      command: process.execPath,
      args: [server],
      resolvedEnv: {
        [MODERN_STUB_DISCOVER_LOG_ENV]: discoverLog,
        [MODERN_STUB_START_DELAY_ENV]: String(opts.startDelayMs ?? 0),
      },
      cwd: "",
      clientInfo: { name: "era-test", version: "0" },
      clientCapabilities: {},
      protocolVersion: "2025-11-25",
    };
    return { spec, discovers: async () => (await readFile(discoverLog, "utf-8")).split("\n").filter(Boolean).length };
  }

  async function connection(): Promise<DaemonClient> {
    const client = new DaemonClient({ socketPath: join(dir, "m.sock"), transport: netTransport, rpcTimeoutMs: 5_000, connectTimeoutMs: 5_000 });
    clients.push(client);
    await client.connect();
    return client;
  }

  async function session(spec: unknown) {
    const client = await connection();
    const replies: Reply[] = [];
    client.setNotificationHandler((notif) => {
      if (notif.method === "RPC") replies.push((notif.params as { payload: Reply }).payload);
    });
    const sessionId = randomUUID();
    await client.call("OPEN", { sessionId, spec });
    const send = (payload: unknown) => client.sendNotification("RPC", { sessionId, payload });
    const replyTo = async (id: unknown) => {
      await until(() => replies.some((reply) => reply.id === id), 10_000);
      return replies.find((reply) => reply.id === id)!;
    };
    const request = async (payload: { id: string | number }) => {
      send(payload);
      return replyTo(payload.id);
    };
    return { send, request, replyTo, close: () => client.call("CLOSE", { sessionId }) };
  }

  const era = async () => ((await (await connection()).call("STATUS")) as StatusResult).children[0]!.era;

  it("confirms the modern era once a modern request follows the probe, and answers later probes itself", async () => {
    const { spec, discovers } = await start();
    const current = await session(spec);
    expect(await current.request(probe("p-1"))).toMatchObject({ result: { supportedVersions: expect.any(Array) } });
    expect(await current.request(modernRequest("list-1"))).toMatchObject({ result: { tools: expect.any(Array) } });

    const next = await session(spec);
    expect(await next.request(probe("p-2"))).toMatchObject({ result: { supportedVersions: expect.any(Array) } });

    expect(await era()).toBe("modern");
    expect(await discovers()).toBe(1);
  });

  it("asks the child again when a released bridge's initialize lands between the probe answer and the first modern request", async () => {
    const { spec } = await start();
    const current = await session(spec);
    const released = await session(spec);
    await current.request(probe("p-1"));
    expect(await released.request(initialize(1))).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    await current.request(modernRequest("list-1"));

    const next = await session(spec);
    expect(await next.request(probe("p-2"))).toMatchObject({ error: { code: ProtocolErrorCode.MethodNotFound } });
    expect(await era()).toBe("legacy");
  });

  it("asks the child again when the daemon's ping reaches it before any modern request", async () => {
    const { spec } = await start({ childPingMs: 100 });
    const current = await session(spec);
    await current.request(probe("p-1"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await current.request(modernRequest("list-1"));

    const next = await session(spec);
    expect(await next.request(probe("p-2"))).toMatchObject({ error: { code: ProtocolErrorCode.MethodNotFound } });
    expect(await era()).toBe("legacy");
  });

  it("doesn't cancel a detaching session's probe, so a slow child still settles the modern era", async () => {
    const { spec, discovers } = await start({ startDelayMs: 500 });
    const current = await session(spec);
    const leaving = await session(spec);
    current.send(probe("p-1"));
    leaving.send(probe("p-9"));
    await leaving.close();

    expect(await current.replyTo("p-1")).toMatchObject({ result: { supportedVersions: expect.any(Array) } });
    expect(await current.request(modernRequest("list-1"))).toMatchObject({ result: { tools: expect.any(Array) } });

    const next = await session(spec);
    expect(await next.request(probe("p-2"))).toMatchObject({ result: { supportedVersions: expect.any(Array) } });
    expect(await era()).toBe("modern");
    expect(await discovers()).toBe(2);
  });
});
