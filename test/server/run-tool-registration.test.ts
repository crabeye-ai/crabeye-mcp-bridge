import { describe, it, expect, afterEach } from "vitest";
import { Client, InMemoryTransport as ClientInMemoryTransport, type Transport } from "@modelcontextprotocol/client";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { BaseUpstreamClient } from "../../src/upstream/base-client.js";
import type { UpstreamClient } from "../../src/upstream/types.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { BridgeServer } from "../../src/server/bridge-server.js";
import { transportKeepingFirstMessageHandler } from "../_helpers/transports.js";
import { errorResult } from "../_helpers/run-tool.js";
import { localSearch } from "../_helpers/local-search.js";
import { FakeInstanceLink } from "../_helpers/fake-instance-link.js";

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

function runEcho(client: Client, source: string) {
  return client.callTool({ name: "run_tool", arguments: { name: `${source}__echo`, arguments: {} } });
}

describe("upstream registration", () => {
  let cleanups: Array<() => unknown> = [];
  let manager: UpstreamManager;
  let link: FakeInstanceLink;

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    cleanups = [];
  });

  function startManager(names: string[], toolRegistry = new ToolRegistry()): void {
    link = new FakeInstanceLink();
    manager = new UpstreamManager({ names, toolRegistry, instanceLink: link, _clientFactory: inMemoryClient });
    cleanups.push(() => manager.closeAll());
  }

  async function startBridge(
    names: string[],
    wrapTransport: (transport: ClientInMemoryTransport) => Transport = (transport) => transport,
  ): Promise<Client> {
    const toolRegistry = new ToolRegistry();
    startManager(names, toolRegistry);
    const server = new BridgeServer({
      toolRegistry,
      search: localSearch(toolRegistry),
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
    it("reaches a server", async () => {
      const client = await startBridge(["alpha"]);

      expect((await runEcho(client, "alpha")).content).toEqual([{ type: "text", text: "echoed" }]);
    });

    it("reaches a server when the transport drops the session watcher", async () => {
      const client = await startBridge(["alpha"], transportKeepingFirstMessageHandler);

      expect((await runEcho(client, "alpha")).content).toEqual([{ type: "text", text: "echoed" }]);
    });

    it("reports a server that is not configured as not found", async () => {
      const client = await startBridge(["alpha"]);

      expect(await runEcho(client, "ghost")).toMatchObject(errorResult("Upstream server not found: ghost"));
    });
  });

  it("run_tool reaches a server the instance has just gained", async () => {
    const client = await startBridge(["beta"]);
    await client.listTools();

    link.setUpstreams(["alpha", "beta"]);

    expect((await runEcho(client, "alpha")).content).toEqual([{ type: "text", text: "echoed" }]);
  });
});
