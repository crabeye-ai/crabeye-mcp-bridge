import { describe, it, expect, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { BridgeConfigSchema, type BridgeConfig } from "../../src/config/schema.js";
import { spyLogger } from "../_helpers/spy-logger.js";
import type {
  ConnectionStatus,
  StatusChangeCallback,
  ToolsChangedCallback,
  UpstreamClient,
} from "../../src/upstream/types.js";

class FakeUpstream implements UpstreamClient {
  status: ConnectionStatus = "disconnected";
  tools: Tool[] = [];
  retryNow = vi.fn(async () => {});
  closed = false;
  private statusListeners = new Set<StatusChangeCallback>();
  private toolsListeners = new Set<ToolsChangedCallback>();

  constructor(readonly name: string) {}

  async connect(): Promise<void> {
    this.tools = [{ name: "lookup", inputSchema: { type: "object" } }];
    this.become("connected");
    for (const listener of this.toolsListeners) listener(this.tools);
  }

  become(status: ConnectionStatus): void {
    const previous = this.status;
    this.status = status;
    for (const listener of this.statusListeners) listener({ previous, current: status });
  }

  async callTool(): Promise<never> {
    throw new Error("not used");
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async ping(): Promise<void> {}
  async reconnect(): Promise<void> {}
  onStatusChange(callback: StatusChangeCallback): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }
  onToolsChanged(callback: ToolsChangedCallback): () => void {
    this.toolsListeners.add(callback);
    return () => this.toolsListeners.delete(callback);
  }
}

function config(servers: string[]): BridgeConfig {
  return BridgeConfigSchema.parse({
    mcpServers: Object.fromEntries(servers.map((name) => [name, { type: "streamable-http", url: `http://localhost/${name}` }])),
    _bridge: { healthCheckInterval: 0, toolPolicy: "always" },
  });
}

async function managerWith(names: string[], logger = spyLogger()) {
  const registry = new ToolRegistry();
  const clients = new Map<string, FakeUpstream>();
  const created: FakeUpstream[] = [];
  const manager = new UpstreamManager({
    config: config(names),
    toolRegistry: registry,
    logger,
    _clientFactory: (name) => {
      const client = new FakeUpstream(name);
      clients.set(name, client);
      created.push(client);
      return client;
    },
  });
  await manager.connectAll();
  return { manager, registry, clients, created };
}

describe("UpstreamManager during upstream outages", () => {
  it.each<ConnectionStatus>(["disconnected", "connecting", "auth_required"])(
    "keeps an upstream's tools searchable while it is %s",
    async (status) => {
      const { manager, registry, clients } = await managerWith(["jira"]);
      expect(registry.listTools().map((t) => t.name)).toEqual(["jira__lookup"]);

      clients.get("jira")!.become(status);

      expect(registry.listTools().map((t) => t.name)).toEqual(["jira__lookup"]);
      await manager.closeAll();
    },
  );

  it("warns once per pause, not on every failed retry", async () => {
    const logger = spyLogger();
    const { manager, clients } = await managerWith(["jira"], logger);
    const jira = clients.get("jira")!;
    const pauseWarnings = () =>
      logger.warn.mock.calls.filter(([message]) => String(message).startsWith("authorization required")).length;

    jira.become("auth_required");
    jira.become("connecting");
    jira.become("auth_required");
    expect(pauseWarnings()).toBe(1);

    jira.become("connecting");
    jira.become("connected");
    jira.become("auth_required");
    expect(pauseWarnings()).toBe(2);
    await manager.closeAll();
  });

  it("retries only the upstreams paused for authorization", async () => {
    const { manager, clients } = await managerWith(["jira", "linear", "notes"]);
    clients.get("jira")!.become("auth_required");
    clients.get("linear")!.become("disconnected");

    manager.retryAuthPaused();

    expect(clients.get("jira")!.retryNow).toHaveBeenCalledOnce();
    expect(clients.get("linear")!.retryNow).not.toHaveBeenCalled();
    expect(clients.get("notes")!.retryNow).not.toHaveBeenCalled();
    await manager.closeAll();
  });

  it("replaces a paused upstream whose connection settings changed in a reload", async () => {
    const { manager, registry, clients, created } = await managerWith(["jira"]);
    const paused = clients.get("jira")!;
    paused.become("auth_required");

    await manager.applyConfigDiff(
      {
        servers: { added: [], removed: [], reconnect: [{ name: "jira", config: config(["jira"]).mcpServers.jira! }], updated: [] },
        bridge: { requiresRestart: [] },
      },
      config(["jira"]),
    );
    manager.retryAuthPaused();

    expect(paused.closed).toBe(true);
    expect(created).toHaveLength(2);
    expect(manager.getClient("jira")!.status).toBe("connected");
    expect(paused.retryNow).not.toHaveBeenCalled();
    expect(registry.listTools().map((t) => t.name)).toEqual(["jira__lookup"]);
    await manager.closeAll();
  });

  it("does not retry a paused upstream that was removed from the config", async () => {
    const { manager, clients } = await managerWith(["jira", "notes"]);
    clients.get("jira")!.become("auth_required");

    await manager.applyConfigDiff(
      {
        servers: { added: [], removed: ["jira"], reconnect: [], updated: [] },
        bridge: { requiresRestart: [] },
      },
      config(["notes"]),
    );
    manager.retryAuthPaused();

    expect(clients.get("jira")!.retryNow).not.toHaveBeenCalled();
    await manager.closeAll();
  });
});
