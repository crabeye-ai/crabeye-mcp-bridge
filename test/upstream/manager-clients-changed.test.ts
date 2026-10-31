import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import type { Transport } from "@modelcontextprotocol/client";
import { BridgeConfigSchema, type BridgeConfig } from "../../src/config/schema.js";
import { diffConfigs } from "../../src/config/config-diff.js";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { BaseUpstreamClient } from "../../src/upstream/base-client.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { createNoopLogger } from "../../src/logging/index.js";
import type { ConnectionStatus, UpstreamClient } from "../../src/upstream/types.js";

function inMemoryUpstream(name: string): Transport {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", () => ({ tools: [] }));
  void server.connect(serverSide);
  return clientSide;
}

class InMemoryUpstreamClient extends BaseUpstreamClient {
  protected _buildTransport(): Transport {
    return inMemoryUpstream(this.name);
  }
}

function clientFactory(name: string): UpstreamClient {
  return new InMemoryUpstreamClient({ name });
}

const http = (url: string) => ({ type: "streamable-http", url });
const stdio = (...args: string[]) => ({ command: "node", args });
const config = (servers: Record<string, unknown>): BridgeConfig => BridgeConfigSchema.parse({ mcpServers: servers });

interface Seen {
  client: UpstreamClient | undefined;
  status: ConnectionStatus | undefined;
}

describe("UpstreamManager clients-changed events", () => {
  let manager: UpstreamManager | undefined;

  afterEach(async () => {
    await manager?.closeAll().catch(() => {});
    manager = undefined;
  });

  async function startWith(servers: Record<string, unknown>, watched = "alpha"): Promise<{ initial: BridgeConfig; seen: Seen[] }> {
    const initial = config(servers);
    manager = new UpstreamManager({ config: initial, toolRegistry: new ToolRegistry(), logger: createNoopLogger(), _clientFactory: clientFactory });
    await manager.connectAll();
    const seen: Seen[] = [];
    manager.onClientsChanged(() => {
      const client = manager!.getClient(watched);
      seen.push({ client, status: client?.status });
    });
    return { initial, seen };
  }

  async function reload(initial: BridgeConfig, servers: Record<string, unknown>): Promise<void> {
    const next = config(servers);
    await manager!.applyConfigDiff(diffConfigs(initial, next), next);
  }

  it("fires once when a reload removes a server, after it is gone", async () => {
    const { initial, seen } = await startWith({ alpha: http("http://localhost:1000"), beta: http("http://localhost:2000") });

    await reload(initial, { beta: http("http://localhost:2000") });

    expect(seen).toEqual([{ client: undefined, status: undefined }]);
  });

  it.each([
    ["an HTTP", http("http://localhost:1000"), http("http://localhost:1001")],
    ["a STDIO", stdio("server.js"), stdio("server.js", "--changed")],
  ])("keeps the client and fires nothing when a reload changes how %s server connects", async (_label, before, after) => {
    const { initial, seen } = await startWith({ alpha: before });
    const old = manager!.getClient("alpha");

    await reload(initial, { alpha: after });

    expect(seen).toEqual([]);
    expect(manager!.getClient("alpha")).toBe(old);
  });

  it("fires when a reload adds a server", async () => {
    const { initial, seen } = await startWith({ beta: http("http://localhost:2000") });

    await reload(initial, { alpha: http("http://localhost:1000"), beta: http("http://localhost:2000") });

    expect(seen.map((s) => s.client)).toEqual([manager!.getClient("alpha")]);
  });

  it("stops calling a listener after it unsubscribes", async () => {
    const { initial } = await startWith({ alpha: http("http://localhost:1000") });
    let calls = 0;
    const unsubscribe = manager!.onClientsChanged(() => calls++);
    unsubscribe();

    await reload(initial, {});

    expect(calls).toBe(0);
  });
});
