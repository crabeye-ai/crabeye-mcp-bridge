import { describe, it, expect, afterEach } from "vitest";
import { Client, InMemoryTransport as ClientInMemoryTransport, type Transport } from "@modelcontextprotocol/client";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { BridgeConfigSchema, type ServerConfig } from "../../src/config/schema.js";
import { diffConfigs } from "../../src/config/config-diff.js";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { BaseUpstreamClient } from "../../src/upstream/base-client.js";
import type { UpstreamClient } from "../../src/upstream/types.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { BridgeServer } from "../../src/server/bridge-server.js";
import { ToolSearchService } from "../../src/search/index.js";
import { transportKeepingFirstMessageHandler } from "../_helpers/transports.js";
import { errorResult } from "../_helpers/run-tool.js";

function inMemoryUpstream(): InMemoryTransport {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: "upstream", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
  server.setRequestHandler("tools/call", () => ({ content: [{ type: "text" as const, text: "echoed" }] }));
  void server.connect(serverSide);
  return clientSide;
}

class InMemoryUpstreamClient extends BaseUpstreamClient {
  protected _buildTransport(): Transport {
    return inMemoryUpstream();
  }
}

function inMemoryClient(name: string): UpstreamClient {
  return new InMemoryUpstreamClient({ name });
}

function bridgeConfig(servers: Record<string, unknown>) {
  return BridgeConfigSchema.parse({ mcpServers: servers });
}

function runEcho(client: Client, source: string) {
  return client.callTool({ name: "run_tool", arguments: { name: `${source}__echo`, arguments: {} } });
}

describe("upstream registration", () => {
  let cleanups: Array<() => unknown> = [];
  let manager: UpstreamManager;

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups = [];
  });

  function startManager(servers: Record<string, unknown>, toolRegistry = new ToolRegistry()): void {
    manager = new UpstreamManager({ config: bridgeConfig(servers), toolRegistry, _clientFactory: inMemoryClient });
    cleanups.push(() => manager.closeAll());
  }

  async function startBridge(
    servers: Record<string, unknown>,
    wrapTransport: (transport: ClientInMemoryTransport) => Transport = (transport) => transport,
  ): Promise<Client> {
    const toolRegistry = new ToolRegistry();
    startManager(servers, toolRegistry);
    const server = new BridgeServer({
      toolRegistry,
      toolSearchService: new ToolSearchService(toolRegistry),
      getUpstreamClient: (name) => manager.getClient(name),
      onClientsChanged: (listener) => manager.onClientsChanged(listener),
    });
    cleanups.push(() => server.close());
    const [clientSide, serverSide] = ClientInMemoryTransport.createLinkedPair();
    await server.connect(wrapTransport(serverSide));
    void server.sessionStarted().then(() => manager.connectAll());
    const client = new Client({ name: "modern", version: "1" }, { versionNegotiation: { mode: "auto" } });
    cleanups.push(() => client.close());
    await client.connect(clientSide);
    expect(client.getProtocolEra()).toBe("modern");
    return client;
  }

  describe("run_tool as a modern client's first request after its version probe", () => {
    it.each([
      ["a STDIO server", { command: "node", args: ["server.js"] }],
      ["a STDIO server whose env reads the credential store", { command: "node", args: ["server.js"], env: { TOKEN: "${credential:token}" } }],
      ["an HTTP server", { type: "streamable-http", url: "http://127.0.0.1:1/mcp" }],
    ] as Array<[string, ServerConfig | Record<string, unknown>]>)("reaches %s", async (_name, alpha) => {
      const client = await startBridge({ alpha });

      expect((await runEcho(client, "alpha")).content).toEqual([{ type: "text", text: "echoed" }]);
    });

    it("reaches a STDIO server whose env reads the credential store when the transport drops the session watcher", async () => {
      const client = await startBridge(
        { alpha: { command: "node", args: ["server.js"], env: { TOKEN: "${credential:token}" } } },
        transportKeepingFirstMessageHandler,
      );

      expect((await runEcho(client, "alpha")).content).toEqual([{ type: "text", text: "echoed" }]);
    });

    it("reports a server that is not configured as not found", async () => {
      const client = await startBridge({ alpha: { command: "node", args: ["server.js"] } });

      expect(await runEcho(client, "ghost")).toMatchObject(errorResult("Upstream server not found: ghost"));
    });
  });

  it("run_tool reaches a STDIO server that a reload is still adding", async () => {
    const before = { beta: { command: "node", args: ["other.js"] } };
    const client = await startBridge(before);
    await client.listTools();
    const next = bridgeConfig({ ...before, alpha: { command: "node", args: ["server.js"], env: { TOKEN: "${credential:token}" } } });
    const reload = manager.applyConfigDiff(diffConfigs(bridgeConfig(before), next), next);

    expect((await runEcho(client, "alpha")).content).toEqual([{ type: "text", text: "echoed" }]);
    await reload;
  });
});
