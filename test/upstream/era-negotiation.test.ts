import { describe, it, expect, afterEach } from "vitest";
import { CLIENT_INFO_META_KEY, Server, InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Tool, Transport, JSONRPCMessage } from "@modelcontextprotocol/server";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { APP_NAME, APP_VERSION } from "../../src/constants.js";

function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object" as const },
  };
}

function createMockServer(tools: Tool[]): Server {
  const server = new Server(
    { name: "mock-upstream", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", () => ({ tools }));
  server.setRequestHandler("tools/call", (request) => ({
    content: [{ type: "text" as const, text: `Called ${request.params.name}` }],
  }));
  return server;
}

interface SeenIdentity {
  envelopeClientInfo: unknown;
  handshakeClientInfo: unknown;
}

function identityCapturingServer(seen: SeenIdentity[]): Server {
  const server = createMockServer([makeTool("tool-a")]);
  server.setRequestHandler("tools/call", (_request, ctx) => {
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    seen.push({
      envelopeClientInfo: envelope?.[CLIENT_INFO_META_KEY],
      handshakeClientInfo: server.getClientVersion(),
    });
    return { content: [] };
  });
  return server;
}

function legacyOnly(clientSide: Transport): Transport {
  const send = clientSide.send.bind(clientSide);
  clientSide.send = async (message: JSONRPCMessage, options?) => {
    const req = message as { method?: string; id?: number | string };
    if (req.method === "server/discover" && req.id !== undefined) {
      queueMicrotask(() => {
        clientSide.onmessage?.({
          jsonrpc: "2.0",
          id: req.id!,
          error: { code: -32601, message: "Method not found" },
        });
      });
      return;
    }
    return send(message, options);
  };
  return clientSide;
}

function linkClient(
  makeMock: () => Server,
  opts?: { legacyOnly?: boolean },
) {
  return new HttpUpstreamClient({
    name: "mock",
    config: { type: "streamable-http", url: "http://localhost:9999" },
    _transportFactory: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      if (opts?.legacyOnly) {
        void makeMock().connect(serverSide);
        return legacyOnly(clientSide);
      }
      serveStdio(() => makeMock(), { transport: serverSide });
      return clientSide;
    },
  });
}

describe("upstream era negotiation", () => {
  const bridgeIdentity = { name: `${APP_NAME}/mock`, version: APP_VERSION };
  let client: HttpUpstreamClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("lands modern against a v2 upstream and works end to end", async () => {
    client = linkClient(() => createMockServer([makeTool("tool-a")]));
    await client.connect();

    expect(client.protocolEra()).toBe("modern");
    expect(client.tools.map((t) => t.name)).toEqual(["tool-a"]);

    const result = await client.callTool({ name: "tool-a", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "Called tool-a" }]);

    await expect(client.ping()).resolves.toBeUndefined();
  });

  it("falls back to legacy against a 2025-only upstream and works end to end", async () => {
    client = linkClient(() => createMockServer([makeTool("tool-a")]), {
      legacyOnly: true,
    });
    await client.connect();

    expect(client.protocolEra()).toBe("legacy");
    expect(client.tools.map((t) => t.name)).toEqual(["tool-a"]);

    const result = await client.callTool({ name: "tool-a", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "Called tool-a" }]);

    await expect(client.ping()).resolves.toBeUndefined();
  });

  it("sends the bridge identity in the request envelope to a modern upstream", async () => {
    const seen: SeenIdentity[] = [];
    client = linkClient(() => identityCapturingServer(seen));
    await client.connect();
    expect(client.protocolEra()).toBe("modern");

    await client.callTool({ name: "tool-a", arguments: {} });

    expect(seen).toHaveLength(1);
    expect(seen[0].envelopeClientInfo).toEqual(expect.objectContaining(bridgeIdentity));
  });

  it("sends the same identity at initialize to a legacy upstream", async () => {
    const seen: SeenIdentity[] = [];
    client = linkClient(() => identityCapturingServer(seen), { legacyOnly: true });
    await client.connect();
    expect(client.protocolEra()).toBe("legacy");

    await client.callTool({ name: "tool-a", arguments: {} });

    expect(seen).toHaveLength(1);
    expect(seen[0].envelopeClientInfo).toBeUndefined();
    expect(seen[0].handshakeClientInfo).toEqual(expect.objectContaining(bridgeIdentity));
  });
});
