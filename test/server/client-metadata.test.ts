import { describe, it, expect } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import type { ProtocolEra, ServerContext } from "@modelcontextprotocol/server";
import { BridgeServer } from "../../src/server/bridge-server.js";
import { ClientMetadata, type HandshakeSource } from "../../src/server/client-metadata.js";
import { spyLogger, type SpyLogger } from "../_helpers/spy-logger.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const expectedProtocolVersion: Record<ProtocolEra, string> = {
  legacy: LATEST_PROTOCOL_VERSION,
  modern: MODERN_PROTOCOL_VERSION,
};

function clientConnectedLines(logger: SpyLogger) {
  return logger.info.mock.calls.filter(([message]) => message === "client connected");
}

async function connectClient(bridge: BridgeServer, era: ProtocolEra, name = "claude-code") {
  const client = new Client(
    { name, version: "2.1.0" },
    era === "modern" ? { versionNegotiation: { mode: "auto" as const } } : {},
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await bridge.connect(serverSide);
  await client.connect(clientSide);
  return client;
}

function callMissingTool(client: Client) {
  return client.callTool({ name: "nope__missing", arguments: {} }).catch(() => undefined);
}

function burstOfRequests(client: Client) {
  return Promise.all([
    ...Array.from({ length: 5 }, () => client.listTools()),
    ...Array.from({ length: 3 }, () => callMissingTool(client)),
  ]);
}

describe.each(["legacy", "modern"] as const)("client identity logging (%s era)", (era) => {
  it("logs the client once per connection under concurrent requests", async () => {
    const logger = spyLogger();
    const bridge = new BridgeServer({ logger });
    const client = await connectClient(bridge, era);

    await burstOfRequests(client);
    await burstOfRequests(client);

    const lines = clientConnectedLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({
      component: "bridge",
      era,
      clientName: "claude-code",
      clientVersion: "2.1.0",
      protocolVersion: expectedProtocolVersion[era],
    });

    await client.close();
    await bridge.close();
  });

  it("logs again for a new connection", async () => {
    const logger = spyLogger();
    const bridge = new BridgeServer({ logger });

    const first = await connectClient(bridge, era, "first");
    await first.listTools();
    await first.close();
    await bridge.close();

    const second = await connectClient(bridge, era, "second");
    await second.listTools();

    expect(clientConnectedLines(logger).map(([, fields]) => fields.clientName)).toEqual([
      "first",
      "second",
    ]);

    await second.close();
    await bridge.close();
  });
});

describe("client identity logging on a legacy connection", () => {
  it("logs at initialize, before any tools request", async () => {
    const logger = spyLogger();
    const bridge = new BridgeServer({ logger });
    const client = await connectClient(bridge, "legacy");

    expect(clientConnectedLines(logger)).toHaveLength(1);

    await client.close();
    await bridge.close();
  });

  it("logs the handshake identity, not identity keys in request _meta", async () => {
    const logger = spyLogger();
    const bridge = new BridgeServer({ logger });
    const client = await connectClient(bridge, "legacy");

    await client.listTools({
      _meta: {
        [CLIENT_INFO_META_KEY]: { name: "spoofed", version: "6.6.6" },
        [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
      },
    });

    const lines = clientConnectedLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({
      clientName: "claude-code",
      protocolVersion: LATEST_PROTOCOL_VERSION,
    });

    await client.close();
    await bridge.close();
  });

  it("ignores identity keys in request _meta when the handshake names no client", async () => {
    const logger = spyLogger();
    const bridge = new BridgeServer({ logger });
    const client = await connectClient(bridge, "legacy", "");

    await client.listTools({
      _meta: { [CLIENT_INFO_META_KEY]: { name: "spoofed", version: "6.6.6" } },
    });

    expect(clientConnectedLines(logger)).toEqual([]);

    await client.close();
    await bridge.close();
  });

  it("stays silent and keeps serving when the client sends an empty clientInfo", async () => {
    const logger = spyLogger();
    const bridge = new BridgeServer({ logger });
    const client = await connectClient(bridge, "legacy", "");

    await expect(client.listTools()).resolves.toEqual({ tools: [] });

    expect(clientConnectedLines(logger)).toEqual([]);

    await client.close();
    await bridge.close();
  });
});

describe("client identity logging on a modern connection", () => {
  function modernListTools(id: number, clientInfo?: { name: string; version: string }) {
    return {
      jsonrpc: "2.0" as const,
      id,
      method: "tools/list",
      params: {
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
          [CLIENT_CAPABILITIES_META_KEY]: {},
          ...(clientInfo ? { [CLIENT_INFO_META_KEY]: clientInfo } : {}),
        },
      },
    };
  }

  async function listToolsSucceeds(
    transport: InMemoryTransport,
    request: ReturnType<typeof modernListTools>,
  ) {
    const replied = new Promise<JSONRPCMessage>((resolve) => {
      transport.onmessage = (message) => {
        if ("id" in message && message.id === request.id) resolve(message);
      };
    });
    await transport.send(request);
    expect(await replied).toMatchObject({ id: request.id, result: { tools: [] } });
  }

  it("logs when the first request is a tool call", async () => {
    const logger = spyLogger();
    const bridge = new BridgeServer({ logger });
    const client = await connectClient(bridge, "modern");

    await callMissingTool(client);

    expect(clientConnectedLines(logger)).toHaveLength(1);

    await client.close();
    await bridge.close();
  });

  it("waits for a request that names the client, then logs it once", async () => {
    const logger = spyLogger();
    const bridge = new BridgeServer({ logger });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await bridge.connect(serverSide);
    await clientSide.start();

    await listToolsSucceeds(clientSide, modernListTools(1));
    expect(clientConnectedLines(logger)).toEqual([]);

    await listToolsSucceeds(clientSide, modernListTools(2, { name: "late", version: "3.0.0" }));
    await listToolsSucceeds(clientSide, modernListTools(3, { name: "other", version: "9.9.9" }));

    const lines = clientConnectedLines(logger);
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({
      era: "modern",
      clientName: "late",
      clientVersion: "3.0.0",
    });

    await clientSide.close();
    await bridge.close();
  });
});

function ctxWith(envelope: Record<string, unknown> | undefined): ServerContext {
  return { mcpReq: { envelope } } as unknown as ServerContext;
}

function handshake(
  info: { name: string; version: string } | undefined,
  overrides: Partial<HandshakeSource> = {},
): HandshakeSource {
  return {
    getClientVersion: () => info,
    getNegotiatedProtocolVersion: () => (info ? LATEST_PROTOCOL_VERSION : undefined),
    getClientCapabilities: () => undefined,
    ...overrides,
  };
}

describe("ClientMetadata.identity on a modern connection", () => {
  const modern = new ClientMetadata("modern", handshake({ name: "from-handshake", version: "1" }));

  it("reads identity and protocol version from the request envelope", () => {
    const ctx = ctxWith({
      [CLIENT_INFO_META_KEY]: { name: "cursor", version: "2" },
      [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
    });

    expect(modern.identity(ctx)).toEqual({
      name: "cursor",
      version: "2",
      protocolVersion: MODERN_PROTOCOL_VERSION,
    });
  });

  it("returns undefined without a named client in the envelope", () => {
    expect(modern.identity(undefined)).toBeUndefined();
    expect(modern.identity(ctxWith(undefined))).toBeUndefined();
    expect(modern.identity(ctxWith({}))).toBeUndefined();
    const unnamed = ctxWith({ [CLIENT_INFO_META_KEY]: { name: "", version: "1" } });
    expect(modern.identity(unnamed)).toBeUndefined();
  });
});

describe("ClientMetadata.identity on a legacy connection", () => {
  it("reads identity and protocol version from the initialize handshake", () => {
    const legacy = new ClientMetadata("legacy", handshake({ name: "claude-code", version: "1" }));

    expect(legacy.identity()).toEqual({
      name: "claude-code",
      version: "1",
      protocolVersion: LATEST_PROTOCOL_VERSION,
    });
  });

  it("returns undefined before initialize or for a nameless client", () => {
    expect(new ClientMetadata("legacy", handshake(undefined)).identity()).toBeUndefined();
    const nameless = handshake({ name: "", version: "1" });
    expect(new ClientMetadata("legacy", nameless).identity()).toBeUndefined();
  });
});

describe("ClientMetadata", () => {
  const envelope = ctxWith({
    [CLIENT_INFO_META_KEY]: { name: "from-envelope", version: "2" },
    [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
    [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { url: {} } },
  });
  const source = handshake(
    { name: "from-handshake", version: "1" },
    { getClientCapabilities: () => ({ elicitation: { form: {} } }) },
  );

  it("reads a modern connection's client from the request envelope only", () => {
    const client = new ClientMetadata("modern", source);

    expect(client.identity(envelope)?.name).toBe("from-envelope");
    expect(client.identity(undefined)).toBeUndefined();
    expect(client.supportsFormElicitation(envelope)).toBe(false);
    expect(client.supportsFormElicitation(ctxWith({}))).toBe(false);
  });

  it("reads a legacy connection's client from the handshake only", () => {
    const client = new ClientMetadata("legacy", source);

    expect(client.identity(envelope)?.name).toBe("from-handshake");
    expect(client.identity(undefined)?.name).toBe("from-handshake");
    expect(client.supportsFormElicitation(envelope)).toBe(true);
  });
});

describe("ClientMetadata.supportsFormElicitation", () => {
  it.each([
    ["no elicitation capability", undefined, false],
    ["a bare elicitation capability (form by default)", {}, true],
    ["form mode", { form: {} }, true],
    ["url mode only", { url: {} }, false],
    ["form and url modes", { form: {}, url: {} }, true],
  ])("with %s → %s", (_label, elicitation, expected) => {
    const client = new ClientMetadata("modern", handshake(undefined));
    const ctx = ctxWith({
      [CLIENT_CAPABILITIES_META_KEY]: elicitation === undefined ? {} : { elicitation },
    });

    expect(client.supportsFormElicitation(ctx)).toBe(expected);
  });
});
