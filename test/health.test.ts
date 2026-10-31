import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Tool, CallToolResult } from "@modelcontextprotocol/server";
import { HealthChecks, type HealthChecksOptions } from "../src/upstream/health-checks.js";
import {
  ConnectionSupersededError,
  type UpstreamClient,
  type ConnectionStatus,
  type StatusChangeCallback,
  type ToolsChangedCallback,
} from "../src/upstream/types.js";
import { spyLogger } from "./_helpers/spy-logger.js";

function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object" as const },
  };
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

  async retryNow(): Promise<void> {}

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
  let running: HealthChecks | undefined;

  async function connectedClient(name = "srv"): Promise<MockUpstreamClient> {
    const client = new MockUpstreamClient(name, [makeTool("t")]);
    await client.connect();
    return client;
  }

  function startChecks(
    clients: MockUpstreamClient[],
    options: Partial<HealthChecksOptions> = {},
  ): HealthChecks {
    const checks = new HealthChecks({ intervalSec: 10, logger: spyLogger(), ...options });
    for (const client of clients) checks.add(client, client.name);
    checks.start();
    running = checks;
    return checks;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    running?.stop();
    running = undefined;
    vi.useRealTimers();
  });

  it("marks client as healthy after successful ping", async () => {
    const mockClient = await connectedClient();
    const checks = startChecks([mockClient]);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(checks.healthOf(mockClient).health).toBe("healthy");
    expect(checks.healthOf(mockClient).lastPingAt).toBeDefined();
  });

  it("marks client as unhealthy after ping failure", async () => {
    const mockClient = await connectedClient();
    mockClient.pingFn = () => Promise.reject(new Error("timeout"));
    const checks = startChecks([mockClient]);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(checks.healthOf(mockClient).health).toBe("unhealthy");
  });

  it("calls reconnect() after 3 consecutive ping failures", async () => {
    const mockClient = await connectedClient();
    mockClient.pingFn = () => Promise.reject(new Error("timeout"));
    const reconnectSpy = vi.fn(() => Promise.resolve());
    mockClient.reconnectFn = reconnectSpy;
    startChecks([mockClient]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnectSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnectSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnectSpy).toHaveBeenCalledTimes(1);
  });

  it("calls onUnhealthy instead of reconnect() when given", async () => {
    const mockClient = await connectedClient();
    mockClient.pingFn = () => Promise.reject(new Error("timeout"));
    const reconnectSpy = vi.fn(() => Promise.resolve());
    mockClient.reconnectFn = reconnectSpy;
    const onUnhealthy = vi.fn<(client: UpstreamClient) => Promise<void>>(() => Promise.resolve());
    startChecks([mockClient], { onUnhealthy });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(onUnhealthy).toHaveBeenCalledTimes(1);
    expect(onUnhealthy).toHaveBeenCalledWith(mockClient);
    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["logs a reconnect that fails", new Error("refused"), true],
    ["doesn't log a reconnect whose connect another reconnect or a close replaced", new ConnectionSupersededError("srv"), false],
  ])("%s", async (_label, failure, logged) => {
    const mockClient = await connectedClient();
    mockClient.pingFn = () => Promise.reject(new Error("timeout"));
    mockClient.reconnectFn = () => Promise.reject(failure);
    const logger = spyLogger();
    startChecks([mockClient], { logger, unhealthyThreshold: 1 });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(logger.error.mock.calls.some(([message]) => message === "failed to recover from failed pings")).toBe(logged);
  });

  it("does not reconnect when the third failed ping paused the upstream for authorization", async () => {
    const mockClient = await connectedClient();
    let pings = 0;
    mockClient.pingFn = () => {
      if (++pings === 3) mockClient.status = "auth_required";
      return Promise.reject(new Error(pings === 3 ? "unauthorized" : "timeout"));
    };
    const reconnectSpy = vi.fn(() => Promise.resolve());
    mockClient.reconnectFn = reconnectSpy;
    startChecks([mockClient]);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(pings).toBe(3);
    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  it("resets failure counter after successful ping", async () => {
    const mockClient = await connectedClient();
    let failCount = 0;
    mockClient.pingFn = () => {
      failCount++;
      if (failCount <= 2) return Promise.reject(new Error("timeout"));
      return Promise.resolve();
    };
    const reconnectSpy = vi.fn(() => Promise.resolve());
    mockClient.reconnectFn = reconnectSpy;
    const checks = startChecks([mockClient]);

    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconnectSpy).not.toHaveBeenCalled();

    expect(checks.healthOf(mockClient).health).toBe("healthy");
  });

  it("does not start health checks when interval is 0", async () => {
    const mockClient = await connectedClient();
    const pingSpy = vi.fn(() => Promise.resolve());
    mockClient.pingFn = pingSpy;
    startChecks([mockClient], { intervalSec: 0 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(pingSpy).not.toHaveBeenCalled();
  });

  it.each<ConnectionStatus>(["disconnected", "connecting", "auth_required"])("skips %s clients during health check", async (status) => {
    const connectedSrv = await connectedClient("connected-srv");
    const disconnectedSrv = await connectedClient("disconnected-srv");
    const connectedPingSpy = vi.fn(() => Promise.resolve());
    const disconnectedPingSpy = vi.fn(() => Promise.resolve());
    connectedSrv.pingFn = connectedPingSpy;
    disconnectedSrv.pingFn = disconnectedPingSpy;
    disconnectedSrv.status = status;
    startChecks([connectedSrv, disconnectedSrv]);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(connectedPingSpy).toHaveBeenCalledTimes(1);
    expect(disconnectedPingSpy).not.toHaveBeenCalled();
  });

  it("health state is unknown before first ping", async () => {
    const mockClient = await connectedClient();
    const checks = startChecks([mockClient]);

    expect(checks.healthOf(mockClient).health).toBe("unknown");
    expect(checks.healthOf(mockClient).lastPingAt).toBeUndefined();
  });

  it("stop() stops the interval", async () => {
    const mockClient = await connectedClient();
    const pingSpy = vi.fn(() => Promise.resolve());
    mockClient.pingFn = pingSpy;
    const checks = startChecks([mockClient]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(pingSpy).toHaveBeenCalledTimes(1);

    checks.stop();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(pingSpy).toHaveBeenCalledTimes(1);
  });

  it("restart() applies the new interval", async () => {
    const mockClient = await connectedClient();
    const pingSpy = vi.fn(() => Promise.resolve());
    mockClient.pingFn = pingSpy;
    const checks = startChecks([mockClient], { intervalSec: 30 });

    checks.restart(5);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(pingSpy).toHaveBeenCalledTimes(1);
  });

  it("skips client when previous ping is still in-flight", async () => {
    const mockClient = await connectedClient();
    let pingCount = 0;
    let resolvePing: (() => void) | undefined;
    mockClient.pingFn = () => {
      pingCount++;
      return new Promise<void>((resolve) => {
        resolvePing = resolve;
      });
    };
    startChecks([mockClient], { intervalSec: 1 });

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
  });

  it("logs error when reconnect() fails but does not throw", async () => {
    const mockClient = await connectedClient();
    mockClient.pingFn = () => Promise.reject(new Error("timeout"));
    mockClient.reconnectFn = () => Promise.reject(new Error("reconnect failed"));
    const logger = spyLogger();
    const checks = startChecks([mockClient], { logger });

    // 3 failures trigger reconnect, which itself fails
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    // Health state was reset to unknown before reconnect was called
    expect(checks.healthOf(mockClient).health).toBe("unknown");
    expect(logger.error).toHaveBeenCalledWith("failed to recover from failed pings", expect.objectContaining({ server: "srv" }));
  });

  it("resets health tracking to unknown after reconnect trigger", async () => {
    const mockClient = await connectedClient();
    mockClient.pingFn = () => Promise.reject(new Error("timeout"));
    mockClient.reconnectFn = () => Promise.resolve();
    const checks = startChecks([mockClient]);

    // 3 failures to trigger reconnect
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(checks.healthOf(mockClient).health).toBe("unknown");
  });
});
