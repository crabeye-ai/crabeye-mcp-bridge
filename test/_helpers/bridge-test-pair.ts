import { vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { JSONRPCMessage, Tool } from "@modelcontextprotocol/client";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { BridgeServer } from "../../src/server/bridge-server.js";
import type { BridgeServerOptions } from "../../src/server/bridge-server.js";
import type { UpstreamClient } from "../../src/upstream/types.js";

export function makeTool(name: string, description?: string): Tool {
  return {
    name,
    description: description ?? `Tool ${name}`,
    inputSchema: { type: "object" as const },
  };
}

export async function createTestPair(options?: Partial<BridgeServerOptions> & { registry?: ToolRegistry; modern?: boolean }) {
  const { registry, modern, ...serverOptions } = options ?? {};
  const toolRegistry = registry ?? new ToolRegistry();
  const server = new BridgeServer({ ...serverOptions, toolRegistry });

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    modern ? { versionNegotiation: { mode: "auto" } } : undefined,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sentByServer: JSONRPCMessage[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = (message, sendOptions) => {
    sentByServer.push(message);
    return send(message, sendOptions);
  };

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    server,
    client,
    toolRegistry,
    notificationsFromServer: () => sentByServer.filter((message) => !("id" in message)),
    async cleanup() {
      await client.close();
      await server.close();
    },
  };
}

export function makeMockUpstreamClient(
  name: string,
  overrides?: Partial<UpstreamClient>,
): UpstreamClient {
  return {
    name,
    status: "connected",
    tools: [],
    connect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: `called on ${name}` }],
    }),
    close: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    retryNow: vi.fn().mockResolvedValue(undefined),
    onStatusChange: vi.fn().mockReturnValue(() => {}),
    onToolsChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

export class FakeUpstreams {
  private readonly byName = new Map<string, UpstreamClient>();
  readonly changeListeners = new Set<() => void>();

  set(name: string, client: UpstreamClient | undefined): void {
    if (client) this.byName.set(name, client);
    else this.byName.delete(name);
    for (const listener of [...this.changeListeners]) listener();
  }

  get = (name: string): UpstreamClient | undefined => this.byName.get(name);

  onClientsChanged = (listener: () => void): (() => void) => {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  };
}
