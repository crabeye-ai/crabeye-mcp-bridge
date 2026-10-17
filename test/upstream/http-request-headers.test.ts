import { describe, it, expect, afterEach } from "vitest";
import type { ProtocolEra } from "@modelcontextprotocol/client";
import type { HttpServerConfig } from "../../src/config/schema.js";
import { oauthCredentialKey } from "../../src/oauth/index.js";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { makeTestStore } from "../_helpers/credential-store.js";
import {
  createHeaderRecorder,
  startHeaderRecordingUpstream,
  type RecordedRequest,
} from "../_helpers/header-recording-upstream.js";
import { startProtectedUpstream } from "../_helpers/protected-upstream.js";
import { spyLogger, type SpyLogger } from "../_helpers/spy-logger.js";

const WRONG_OWNED_HEADERS = {
  "Mcp-Method": "wrong-method",
  "mcp-name": "wrong-name",
  "Mcp-Param-Region": "wrong-region",
  "MCP-Protocol-Version": "1999-01-01",
  "Mcp-Session-Id": "wrong-session",
};
const WRONG_VALUES = Object.values(WRONG_OWNED_HEADERS);
const OTHER_HEADERS = { Authorization: "Bearer static", "Mcp-Client-Tag": "kept", "X-Custom": "kept" };
const OTHER_HEADERS_RECEIVED = { authorization: "Bearer static", "mcp-client-tag": "kept", "x-custom": "kept" };
const IGNORED_WARNING = /ignored configured headers/;

function encoded(value: string): string {
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function jsonRpcRequests(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter((r) => r.method !== undefined);
}

function lastCall(requests: RecordedRequest[]): RecordedRequest {
  const calls = requests.filter((r) => r.method === "tools/call");
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1];
}

function afterProbe(requests: RecordedRequest[]): RecordedRequest[] {
  expect(requests[0].method).toBe("server/discover");
  return requests.slice(1);
}

function routingHeaderNames(request: RecordedRequest): string[] {
  return Object.keys(request.headers).filter((name) => name === "mcp-method" || name === "mcp-name" || name.startsWith("mcp-param-"));
}

function warningsMatching(logger: SpyLogger, pattern: RegExp): string[] {
  return logger.warn.mock.calls.map(([message]) => String(message)).filter((message) => pattern.test(message));
}

function carriesWrongValue(request: RecordedRequest): boolean {
  return Object.values(request.headers).some((value) => WRONG_VALUES.some((wrong) => value.includes(wrong)));
}

describe("request headers sent to a streamable-HTTP upstream", () => {
  let client: HttpUpstreamClient | undefined;
  let closeUpstream: (() => Promise<void>) | undefined;
  let logger: SpyLogger;

  afterEach(async () => {
    await client?.close();
    await closeUpstream?.();
    client = undefined;
    closeUpstream = undefined;
  });

  async function connect(era: ProtocolEra, headers?: Record<string, string>) {
    const upstream = await startHeaderRecordingUpstream({ era });
    closeUpstream = upstream.close;
    logger = spyLogger();
    const config: HttpServerConfig = { type: "streamable-http", url: upstream.url, ...(headers ? { headers } : {}) };
    client = new HttpUpstreamClient({ name: "recorded", config, logger });
    await client.connect();
    expect(client.protocolEra()).toBe(era);
    return upstream;
  }

  async function expectCalled(name: string, args: Record<string, unknown> = {}): Promise<void> {
    const result = await client!.callTool({ name, arguments: args });
    expect(result.content).toEqual([{ type: "text", text: `called ${name}` }]);
  }

  describe("modern protocol", () => {
    it("names the method on every request and the tool only on tool calls", async () => {
      const upstream = await connect("modern");
      await expectCalled("plain");
      await client!.ping();

      const requests = jsonRpcRequests(upstream.requests());
      expect(requests.map((r) => r.method)).toEqual(expect.arrayContaining(["server/discover", "tools/list", "tools/call"]));
      expect(requests.filter((r) => r.method === "server/discover")).toHaveLength(2);
      for (const request of requests) {
        expect(request.headers["mcp-method"]).toBe(request.method);
        if (request.method !== "tools/call") expect(request.headers["mcp-name"]).toBeUndefined();
      }
    });

    it("sends the upstream tool name as Mcp-Name", async () => {
      const upstream = await connect("modern");
      await expectCalled("plain");

      expect(lastCall(upstream.requests()).headers).toMatchObject({ "mcp-method": "tools/call", "mcp-name": "plain" });
    });

    it("encodes a non-ASCII tool name in Mcp-Name", async () => {
      const upstream = await connect("modern");
      await expectCalled("café ☕");

      expect(lastCall(upstream.requests()).headers["mcp-name"]).toBe(encoded("café ☕"));
    });

    it.each([
      ["an ASCII argument as-is", "eu-west", "eu-west"],
      ["a non-ASCII argument encoded", "eu-west ü", encoded("eu-west ü")],
    ])("sends a header-declared argument as Mcp-Param-*: %s", async (_name, region, header) => {
      const upstream = await connect("modern");
      await expectCalled("regional", { region });

      expect(lastCall(upstream.requests()).headers).toMatchObject({ "mcp-name": "regional", "mcp-param-region": header });
    });

    it("sends other configured headers unchanged without a warning", async () => {
      const upstream = await connect("modern", OTHER_HEADERS);
      await expectCalled("plain");

      for (const request of jsonRpcRequests(upstream.requests())) expect(request.headers).toMatchObject(OTHER_HEADERS_RECEIVED);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("ignores transport-owned headers from the config and warns once", async () => {
      const upstream = await connect("modern", { ...WRONG_OWNED_HEADERS, ...OTHER_HEADERS });
      await expectCalled("plain");
      await expectCalled("regional", { region: "eu-west" });
      await client!.reconnect();
      await expectCalled("plain");

      const requests = upstream.requests();
      expect(requests.filter(carriesWrongValue)).toEqual([]);
      for (const request of jsonRpcRequests(requests)) {
        expect(request.headers).toMatchObject(OTHER_HEADERS_RECEIVED);
        expect(request.headers["mcp-method"]).toBe(request.method);
        if (request.method !== "tools/call") expect(routingHeaderNames(request)).toEqual(["mcp-method"]);
      }
      expect(lastCall(requests.filter((r) => r.headers["mcp-name"] === "regional")).headers["mcp-param-region"]).toBe("eu-west");
      const ignored = warningsMatching(logger, IGNORED_WARNING);
      expect(ignored).toHaveLength(1);
      for (const name of Object.keys(WRONG_OWNED_HEADERS)) expect(ignored[0]).toContain(name);
    });
  });

  describe("2025-era protocol", () => {
    it("sends no Mcp-Method, Mcp-Name or Mcp-Param-* after the version probe", async () => {
      const upstream = await connect("legacy");
      await expectCalled("plain");
      await expectCalled("regional", { region: "eu-west" });
      await client!.ping();

      const requests = afterProbe(upstream.requests());
      expect(jsonRpcRequests(requests).map((r) => r.method)).toEqual(expect.arrayContaining(["initialize", "tools/list", "tools/call", "ping"]));
      for (const request of requests) expect(routingHeaderNames(request)).toEqual([]);
    });

    it("connects with transport-owned headers in the config and never sends them", async () => {
      const upstream = await connect("legacy", { ...WRONG_OWNED_HEADERS, ...OTHER_HEADERS });
      await expectCalled("plain");
      await expectCalled("regional", { region: "eu-west" });

      const requests = afterProbe(upstream.requests());
      expect(requests.filter(carriesWrongValue)).toEqual([]);
      for (const request of requests) {
        expect(routingHeaderNames(request)).toEqual([]);
        expect(request.headers).toMatchObject(OTHER_HEADERS_RECEIVED);
      }
      expect(warningsMatching(logger, IGNORED_WARNING)).toHaveLength(1);
    });
  });
});

describe("request headers sent to an OAuth-protected streamable-HTTP upstream", () => {
  let cleanups: Array<() => unknown> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups = [];
  });

  async function connectProtected(headers: Record<string, string>) {
    const { store, cleanup } = makeTestStore("header-oauth-");
    cleanups.push(cleanup);
    const recorder = createHeaderRecorder();
    cleanups.push(recorder.close);
    const upstream = await startProtectedUpstream("ok", { mcpHandler: recorder.handle });
    cleanups.push(upstream.close);
    await store.set(oauthCredentialKey("protected"), {
      type: "oauth2",
      access_token: "valid",
      refresh_token: "refresh",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const logger = spyLogger();
    const client = new HttpUpstreamClient({
      name: "protected",
      config: { type: "streamable-http", url: upstream.url, headers, _bridge: { auth: { type: "oauth2" } } },
      credentialStore: store,
      logger,
    });
    cleanups.push(() => client.close());
    await client.connect();
    expect(client.protocolEra()).toBe("modern");
    return { client, recorder, logger };
  }

  it.each(["Authorization", "authorization"])("sends the managed bearer token and the transport's own headers instead of configured ones (%s), warning once", async (authorizationName) => {
    const { client, recorder, logger } = await connectProtected({
      [authorizationName]: "Bearer static",
      ...WRONG_OWNED_HEADERS,
      "X-Custom": "kept",
    });
    await client.reconnect();

    const result = await client.callTool({ name: "plain", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "called plain" }]);
    const requests = recorder.requests();
    expect(requests.filter(carriesWrongValue)).toEqual([]);
    for (const request of jsonRpcRequests(requests)) {
      expect(request.headers).toMatchObject({ authorization: "Bearer valid", "x-custom": "kept", "mcp-method": request.method });
    }
    expect(lastCall(requests).headers["mcp-name"]).toBe("plain");
    expect(warningsMatching(logger, /stripped static Authorization header/)).toHaveLength(1);
    expect(warningsMatching(logger, IGNORED_WARNING)).toHaveLength(1);
  });

  it("sends other configured headers without a warning when none needs stripping", async () => {
    const { client, recorder, logger } = await connectProtected({ "X-Custom": "kept" });

    await client.callTool({ name: "plain", arguments: {} });

    expect(lastCall(recorder.requests()).headers).toMatchObject({ authorization: "Bearer valid", "x-custom": "kept" });
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
