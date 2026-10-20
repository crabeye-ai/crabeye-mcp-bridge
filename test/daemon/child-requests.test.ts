import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { answerChildRequest, isChildRequest } from "../../src/daemon/child-requests.js";
import type { StatusResult } from "../../src/daemon/protocol.js";
import { APP_NAME } from "../../src/constants.js";
import { OpenSessionFixture, spawnTestManager, type DaemonFixture } from "../_helpers/daemon-fixtures.js";

const isWindows = process.platform === "win32";
const STUB_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "_helpers", "stub-mcp-server-bin.mjs");

const UNSUPPORTED = ["elicitation/create", "sampling/createMessage", "roots/list", "vendor/unknown"];

function unsupported(id: string | number, method: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `${APP_NAME} doesn't support "${method}" requests from upstream servers` },
  };
}

describe("answerChildRequest", () => {
  it.each([1, "r-1"])("answers ping with an empty result (id %s)", (id) => {
    expect(answerChildRequest({ id, method: "ping" })).toEqual({ jsonrpc: "2.0", id, result: {} });
  });

  it.each(UNSUPPORTED)("refuses %s, naming the method", (method) => {
    expect(answerChildRequest({ id: 7, method })).toEqual(unsupported(7, method));
  });

  it("names a long or unprintable method by its shortened, escaped label", () => {
    const method = `vendor/${String.fromCodePoint(0x1b)}${"m".repeat(100)}`;

    expect(answerChildRequest({ id: 7, method })).toEqual(unsupported(7, `vendor/\\x1b${"m".repeat(56)}…`));
  });
});

describe("isChildRequest", () => {
  it.each([
    [{ jsonrpc: "2.0", id: 1, method: "ping" }, true],
    [{ jsonrpc: "2.0", id: "a", method: "roots/list" }, true],
    [{ jsonrpc: "2.0", method: "notifications/message" }, false],
    [{ jsonrpc: "2.0", id: 1, result: {} }, false],
    [{ jsonrpc: "2.0", id: null, method: "ping" }, false],
    [null, false],
    ["ping", false],
  ])("classifies %j as %s", (payload, expected) => {
    expect(isChildRequest(payload)).toBe(expected);
  });
});

describe.skipIf(isWindows)("requests from a shared STDIO child", () => {
  let fx: DaemonFixture;
  const sessions: OpenSessionFixture[] = [];
  let nextId = 1;

  beforeEach(async () => {
    fx = await spawnTestManager();
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.close();
    await fx.stop();
  });

  async function request(session: OpenSessionFixture, method: string, params?: unknown) {
    const id = nextId++;
    session.sendRpc({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) });
    return (await session.waitForFrame((p) => (p as { id?: unknown }).id === id, 5_000)) as {
      result?: { content?: Array<{ text: string }> };
    };
  }

  async function openSession(): Promise<OpenSessionFixture> {
    const session = await OpenSessionFixture.open(fx, { command: process.execPath, args: [STUB_BIN] });
    sessions.push(session);
    await request(session, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    return session;
  }

  function callTool(session: OpenSessionFixture, name: string, args: Record<string, unknown> = {}) {
    return request(session, "tools/call", { name, arguments: args });
  }

  async function repliesSeenByChild(session: OpenSessionFixture): Promise<unknown[]> {
    const response = await callTool(session, "replies");
    return JSON.parse(response.result!.content![0]!.text) as unknown[];
  }

  async function children() {
    return ((await fx.client.call("STATUS")) as StatusResult).children;
  }

  it("answers ping and refuses every other method itself, keeping one child serving both sessions", async () => {
    const a = await openSession();
    const b = await openSession();
    const before = await children();
    expect(before).toHaveLength(1);
    const [child] = before;

    await callTool(b, "emit_request", { method: "ping", id: "p-1" });
    for (const [i, method] of UNSUPPORTED.entries()) await callTool(b, "emit_request", { method, id: i });

    expect(await repliesSeenByChild(a)).toEqual([
      { jsonrpc: "2.0", id: "p-1", result: {} },
      ...UNSUPPORTED.map((method, i) => unsupported(i, method)),
    ]);
    expect(await children()).toEqual([expect.objectContaining({ pid: child!.pid, refcount: 2 })]);
    expect(((await fx.client.call("STATUS")) as StatusResult).telemetry.upstreamRequests).toEqual({
      refusedTotal: { "elicitation/create": 1, "sampling/createMessage": 1, "roots/list": 1, "vendor/unknown": 1 },
    });
    for (const session of [a, b]) {
      expect(session.framesMatching((p) => (p as { method?: unknown }).method !== undefined)).toEqual([]);
    }
  });

  it("names and counts a refused request by its shortened, escaped method label", async () => {
    const session = await openSession();
    const method = `a${String.fromCodePoint(0x1b)}${"m".repeat(100)}`;

    await callTool(session, "emit_request", { method, id: "long" });

    expect(await repliesSeenByChild(session)).toEqual([unsupported("long", `a\\x1b${"m".repeat(62)}…`)]);
    expect(((await fx.client.call("STATUS")) as StatusResult).telemetry.upstreamRequests).toEqual({
      refusedTotal: { [`a\\x1b${"m".repeat(62)}…`]: 1 },
    });
  });
});
