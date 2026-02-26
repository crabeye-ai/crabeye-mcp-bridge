import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeConfig } from "../src/config/schema.js";
import { UpstreamManager } from "../src/upstream/upstream-manager.js";
import { ToolRegistry } from "../src/server/tool-registry.js";
import type {
  UpstreamClient,
  ConnectionStatus,
  StatusChangeCallback,
  ToolsChangedCallback,
} from "../src/upstream/types.js";

function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object" as const },
  };
}

function makeConfig(
  servers: Record<string, unknown>,
  overrides?: { healthCheckInterval?: number },
): BridgeConfig {
  return {
    mcpServers: servers,
    _bridge: {
      port: 19875,
      logLevel: "info",
      logFormat: "text",
      maxUpstreamConnections: 1000,
      connectionTimeout: 30,
      idleTimeout: 600,
      healthCheckInterval: overrides?.healthCheckInterval ?? 30,
      toolPolicy: "always",
    },
  } as BridgeConfig;
}

class MockUpstreamClient implements UpstreamClient {
  readonly name: string;
  status: ConnectionStatus = "disconnected";
  tools: Tool[] = [];

  pingFn: () => Promise<void> = () => Promise.resolve();
  reconnectFn: () => Promise<void> = () => Promise.resolve();

  private _statusListeners = new Set<StatusChangeCallback>();
  private _toolsListeners = new Set<ToolsChangedCallback>();

  constructor(name: string, tools: Tool[] = []) {
    this.name = name;
    this.tools = tools;
  }

  async connect(): Promise<void> {
    this.status = "connected";
    for (const cb of this._statusListeners) {
      cb({ previous: "disconnected", current: "connected" });
    }
    for (const cb of this._toolsListeners) {
      cb(this.tools);
    }
  }

  async callTool(): Promise<CallToolResult> {
    return { content: [{ type: "text", text: "ok" }] };
  }

  async close(): Promise<void> {
    this.status = "disconnected";
  }

  async ping(): Promise<void> {
    return this.pingFn();
  }

  async reconnect(): Promise<void> {
    return this.reconnectFn();
  }

  onStatusChange(callback: StatusChangeCallback): () => void {
    this._statusListeners.add(callback);
    return () => this._statusListeners.delete(callback);
  }

  onToolsChanged(callback: ToolsChangedCallback): () => void {
    this._toolsListeners.add(callback);
    return () => this._toolsListeners.delete(callback);
  }
}

describe("Health monitoring", () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    toolRegistry = new ToolRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks client as healthy after successful ping", async () => {
    const mockClient = new MockUpstreamClient("srv", [makeTool("t")]);

    const config = makeConfig(
      { srv: { type: "streamable-http", url: "http://localhost:9999" } },
      { healthCheckInterval: 10 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: () => mockClient,
    });

    await manager.connectAll();
    manager.startHealthChecks();

    // Trigger health check
    await vi.advanceTimersByTimeAsync(10_000);

    const statuses = manager.getStatuses();
    expect(statuses[0].health).toBe("healthy");
    expect(statuses[0].lastPingAt).toBeDefined();

    await manager.closeAll();
  });

  it("marks client as unhealthy after ping failure", async () => {
    const mockClient = new MockUpstreamClient("srv", [makeTool("t")]);
    mockClient.pingFn = () => Promise.reject(new Error("timeout"));

    const config = makeConfig(
      { srv: { type: "streamable-http", url: "http://localhost:9999" } },
      { healthCheckInterval: 10 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: () => mockClient,
    });

    await manager.connectAll();
    manager.startHealthChecks();

    await vi.advanceTimersByTimeAsync(10_000);

    const statuses = manager.getStatuses();
    expect(statuses[0].health).toBe("unhealthy");

    await manager.closeAll();
  });

  it("calls reconnect() after 3 consecutive ping failures", async () => {
    const mockClient = new MockUpstreamClient("srv", [makeTool("t")]);
    mockClient.pingFn = () => Promise.reject(new Error("timeout"));
    const reconnectSpy = vi.fn(() => Promise.resolve());
    mockClient.reconnectFn = reconnectSpy;

    const config = makeConfig(
      { srv: { type: "streamable-http", url: "http://localhost:9999" } },
      { healthCheckInterval: 10 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: () => mockClient,
    });

    await manager.connectAll();
    manager.startHealthChecks();

    // First failure
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnectSpy).not.toHaveBeenCalled();

    // Second failure
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnectSpy).not.toHaveBeenCalled();

    // Third failure — triggers reconnect
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnectSpy).toHaveBeenCalledTimes(1);

    await manager.closeAll();
  });

  it("resets failure counter after successful ping", async () => {
    const mockClient = new MockUpstreamClient("srv", [makeTool("t")]);
    let failCount = 0;
    mockClient.pingFn = () => {
      failCount++;
      if (failCount <= 2) return Promise.reject(new Error("timeout"));
      return Promise.resolve();
    };
    const reconnectSpy = vi.fn(() => Promise.resolve());
    mockClient.reconnectFn = reconnectSpy;

    const config = makeConfig(
      { srv: { type: "streamable-http", url: "http://localhost:9999" } },
      { healthCheckInterval: 10 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: () => mockClient,
    });

    await manager.connectAll();
    manager.startHealthChecks();

    // Two failures
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    // Third ping succeeds — resets counter
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnectSpy).not.toHaveBeenCalled();

    const statuses = manager.getStatuses();
    expect(statuses[0].health).toBe("healthy");

    await manager.closeAll();
  });

  it("does not start health checks when interval is 0", async () => {
    const mockClient = new MockUpstreamClient("srv", [makeTool("t")]);
    const pingSpy = vi.fn(() => Promise.resolve());
    mockClient.pingFn = pingSpy;

    const config = makeConfig(
      { srv: { type: "streamable-http", url: "http://localhost:9999" } },
      { healthCheckInterval: 0 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: () => mockClient,
    });

    await manager.connectAll();
    manager.startHealthChecks();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pingSpy).not.toHaveBeenCalled();

    await manager.closeAll();
  });

  it("skips non-connected clients during health check", async () => {
    const connectedClient = new MockUpstreamClient("connected-srv", [makeTool("t")]);
    const disconnectedClient = new MockUpstreamClient("disconnected-srv", [makeTool("t2")]);
    const connectedPingSpy = vi.fn(() => Promise.resolve());
    const disconnectedPingSpy = vi.fn(() => Promise.resolve());
    connectedClient.pingFn = connectedPingSpy;
    disconnectedClient.pingFn = disconnectedPingSpy;

    const clients: Record<string, MockUpstreamClient> = {
      "connected-srv": connectedClient,
      "disconnected-srv": disconnectedClient,
    };

    const config = makeConfig(
      {
        "connected-srv": { type: "streamable-http", url: "http://localhost:1111" },
        "disconnected-srv": { type: "streamable-http", url: "http://localhost:2222" },
      },
      { healthCheckInterval: 10 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => clients[name],
    });

    await manager.connectAll();

    // Disconnect one client
    disconnectedClient.status = "disconnected";

    manager.startHealthChecks();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(connectedPingSpy).toHaveBeenCalledTimes(1);
    expect(disconnectedPingSpy).not.toHaveBeenCalled();

    await manager.closeAll();
  });

  it("health state is unknown before first ping", async () => {
    const mockClient = new MockUpstreamClient("srv", [makeTool("t")]);

    const config = makeConfig(
      { srv: { type: "streamable-http", url: "http://localhost:9999" } },
      { healthCheckInterval: 10 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: () => mockClient,
    });

    await manager.connectAll();

    const statuses = manager.getStatuses();
    expect(statuses[0].health).toBe("unknown");
    expect(statuses[0].lastPingAt).toBeUndefined();

    await manager.closeAll();
  });

  it("stopHealthChecks stops the interval", async () => {
    const mockClient = new MockUpstreamClient("srv", [makeTool("t")]);
    const pingSpy = vi.fn(() => Promise.resolve());
    mockClient.pingFn = pingSpy;

    const config = makeConfig(
      { srv: { type: "streamable-http", url: "http://localhost:9999" } },
      { healthCheckInterval: 10 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: () => mockClient,
    });

    await manager.connectAll();
    manager.startHealthChecks();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pingSpy).toHaveBeenCalledTimes(1);

    manager.stopHealthChecks();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(pingSpy).toHaveBeenCalledTimes(1);

    await manager.closeAll();
  });

  it("skips client when previous ping is still in-flight", async () => {
    const mockClient = new MockUpstreamClient("srv", [makeTool("t")]);
    let pingCount = 0;
    let resolvePing: (() => void) | undefined;
    mockClient.pingFn = () => {
      pingCount++;
      return new Promise<void>((resolve) => {
        resolvePing = resolve;
      });
    };

    const config = makeConfig(
      { srv: { type: "streamable-http", url: "http://localhost:9999" } },
      { healthCheckInterval: 1 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: () => mockClient,
    });

    await manager.connectAll();
    manager.startHealthChecks();

    // First check fires — ping starts but doesn't resolve
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pingCount).toBe(1);

    // Second check fires — should skip because first ping is in-flight
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pingCount).toBe(1);

    // Resolve the first ping
    resolvePing!();
    await vi.advanceTimersByTimeAsync(0);

    // Third check fires — should now ping again
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pingCount).toBe(2);

    resolvePing!();
    await manager.closeAll();
  });

  it("logs error when reconnect() fails but does not throw", async () => {
    const mockClient = new MockUpstreamClient("srv", [makeTool("t")]);
    mockClient.pingFn = () => Promise.reject(new Error("timeout"));
    mockClient.reconnectFn = () => Promise.reject(new Error("reconnect failed"));

    const config = makeConfig(
      { srv: { type: "streamable-http", url: "http://localhost:9999" } },
      { healthCheckInterval: 10 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: () => mockClient,
    });

    await manager.connectAll();
    manager.startHealthChecks();

    // 3 failures trigger reconnect, which itself fails
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    // Health state was reset to unknown before reconnect was called
    const statuses = manager.getStatuses();
    expect(statuses[0].health).toBe("unknown");

    // No unhandled rejection — the error is caught internally
    await manager.closeAll();
  });

  it("options.healthCheckInterval overrides config value", async () => {
    const mockClient = new MockUpstreamClient("srv", [makeTool("t")]);
    const pingSpy = vi.fn(() => Promise.resolve());
    mockClient.pingFn = pingSpy;

    // Config says disabled (0), but options override to 5
    const config = makeConfig(
      { srv: { type: "streamable-http", url: "http://localhost:9999" } },
      { healthCheckInterval: 0 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      healthCheckInterval: 5,
      _clientFactory: () => mockClient,
    });

    await manager.connectAll();
    manager.startHealthChecks();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pingSpy).toHaveBeenCalledTimes(1);

    await manager.closeAll();
  });

  it("resets health tracking to unknown after reconnect trigger", async () => {
    const mockClient = new MockUpstreamClient("srv", [makeTool("t")]);
    mockClient.pingFn = () => Promise.reject(new Error("timeout"));
    mockClient.reconnectFn = () => Promise.resolve();

    const config = makeConfig(
      { srv: { type: "streamable-http", url: "http://localhost:9999" } },
      { healthCheckInterval: 10 },
    );

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: () => mockClient,
    });

    await manager.connectAll();
    manager.startHealthChecks();

    // 3 failures to trigger reconnect
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    const statuses = manager.getStatuses();
    expect(statuses[0].health).toBe("unknown");

    await manager.closeAll();
  });
});
