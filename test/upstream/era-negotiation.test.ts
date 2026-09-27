import { describe, it, expect, afterEach } from "vitest";
import { Server, InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Tool, Transport, JSONRPCMessage } from "@modelcontextprotocol/server";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";

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
});
