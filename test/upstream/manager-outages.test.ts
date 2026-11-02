import { describe, it, expect, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
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

async function managerWith(names: string[], logger = spyLogger()) {
  const registry = new ToolRegistry();
  const clients = new Map<string, FakeUpstream>();
  const created: FakeUpstream[] = [];
  const manager = new UpstreamManager({
    names,
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
});
