import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeConfigSchema, type BridgeConfig } from "../src/config/schema.js";
import { diffConfigs } from "../src/config/config-diff.js";
import { UpstreamManager } from "../src/upstream/upstream-manager.js";
import { ToolRegistry } from "../src/server/tool-registry.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import { createLogger, createNoopLogger } from "../src/logging/index.js";
import { HttpUpstreamClient } from "../src/upstream/http-client.js";

function makeTool(name: string, description?: string): Tool {
  return {
    name,
    description: description ?? `Tool ${name}`,
    inputSchema: { type: "object" as const },
  };
}

function createMockServer(tools: Tool[]) {
  const server = new Server(
    { name: "mock-upstream", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request) => ({
    content: [{ type: "text" as const, text: `Called ${request.params.name}` }],
  }));

  return server;
}

function createLinkedClient(
  name: string,
  mockServer: Server,
): HttpUpstreamClient {
  return new HttpUpstreamClient({
    name,
    config: { type: "streamable-http", url: "http://localhost:9999" },
    _transportFactory: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      mockServer.connect(serverSide);
      return clientSide;
    },
  });
}

function makeConfig(
  servers: Record<string, unknown>,
  bridgeOverrides: Record<string, unknown> = {},
): BridgeConfig {
  return BridgeConfigSchema.parse({
    mcpServers: servers,
    _bridge: bridgeOverrides,
  });
}

describe("Config hot-reload integration", () => {
  let toolRegistry: ToolRegistry;
  let upstreamManager: UpstreamManager;
  let policyEngine: PolicyEngine;
  let mockServers: Map<string, Server>;
  const logger = createNoopLogger();

  function clientFactory(name: string) {
    let server = mockServers.get(name);
    if (!server) {
      // Create a default mock server with one tool named after the server
      server = createMockServer([makeTool(`${name}-tool`)]);
      mockServers.set(name, server);
    }
    return createLinkedClient(name, server);
  }

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
    mockServers = new Map();
  });

  afterEach(async () => {
    await upstreamManager?.closeAll().catch(() => {});
    for (const server of mockServers.values()) {
      await server.close().catch(() => {});
    }
  });

  it("add server via config change — client connected, tools registered", async () => {
    const config1 = makeConfig({
      alpha: { type: "streamable-http", url: "http://localhost:1000" },
    });
    mockServers.set("alpha", createMockServer([makeTool("alpha-tool")]));

    upstreamManager = new UpstreamManager({
      config: config1,
      toolRegistry,
      logger,
      _clientFactory: clientFactory,
    });
    policyEngine = new PolicyEngine(config1._bridge.toolPolicy, {});

    await upstreamManager.connectAll();
    expect(toolRegistry.listTools()).toHaveLength(1);
    expect(toolRegistry.getTool("alpha__alpha-tool")).toBeDefined();

    // Add a new server
    const config2 = makeConfig({
      alpha: { type: "streamable-http", url: "http://localhost:1000" },
      beta: { type: "streamable-http", url: "http://localhost:2000" },
    });
    mockServers.set("beta", createMockServer([makeTool("beta-tool")]));

    const diff = diffConfigs(config1, config2);
    expect(diff.servers.added).toHaveLength(1);
    expect(diff.servers.added[0].name).toBe("beta");

    await upstreamManager.applyConfigDiff(diff, config2);

    expect(toolRegistry.listTools()).toHaveLength(2);
    expect(toolRegistry.getTool("beta__beta-tool")).toBeDefined();
    expect(upstreamManager.getClient("beta")!.status).toBe("connected");
  });

  it("remove server via config change — client closed, tools unregistered", async () => {
    const config1 = makeConfig({
      alpha: { type: "streamable-http", url: "http://localhost:1000" },
      beta: { type: "streamable-http", url: "http://localhost:2000" },
    });
    mockServers.set("alpha", createMockServer([makeTool("alpha-tool")]));
    mockServers.set("beta", createMockServer([makeTool("beta-tool")]));

    upstreamManager = new UpstreamManager({
      config: config1,
      toolRegistry,
      logger,
      _clientFactory: clientFactory,
    });
    policyEngine = new PolicyEngine(config1._bridge.toolPolicy, {});

    await upstreamManager.connectAll();
    expect(toolRegistry.listTools()).toHaveLength(2);

    // Remove beta
    const config2 = makeConfig({
      alpha: { type: "streamable-http", url: "http://localhost:1000" },
    });

    const diff = diffConfigs(config1, config2);
    expect(diff.servers.removed).toEqual(["beta"]);

    await upstreamManager.applyConfigDiff(diff, config2);

    expect(toolRegistry.listTools()).toHaveLength(1);
    expect(toolRegistry.getTool("beta__beta-tool")).toBeUndefined();
    expect(upstreamManager.getClient("beta")).toBeUndefined();
  });

  it("modify server connection fields — reconnect (old closed, new connected)", async () => {
    const config1 = makeConfig({
      alpha: { type: "streamable-http", url: "http://localhost:1000" },
    });
    mockServers.set("alpha", createMockServer([makeTool("v1-tool")]));

    upstreamManager = new UpstreamManager({
      config: config1,
      toolRegistry,
      logger,
      _clientFactory: clientFactory,
    });

    await upstreamManager.connectAll();
    expect(toolRegistry.getTool("alpha__v1-tool")).toBeDefined();
    const oldClient = upstreamManager.getClient("alpha");

    // Change URL — triggers reconnect
    const config2 = makeConfig({
      alpha: { type: "streamable-http", url: "http://localhost:2000" },
    });
    // Update mock server with new tools for the reconnected client
    mockServers.set("alpha", createMockServer([makeTool("v2-tool")]));

    const diff = diffConfigs(config1, config2);
    expect(diff.servers.reconnect).toHaveLength(1);

    await upstreamManager.applyConfigDiff(diff, config2);

    const newClient = upstreamManager.getClient("alpha");
    expect(newClient).toBeDefined();
    expect(newClient).not.toBe(oldClient);
    expect(newClient!.status).toBe("connected");
    expect(toolRegistry.getTool("alpha__v2-tool")).toBeDefined();
    expect(toolRegistry.getTool("alpha__v1-tool")).toBeUndefined();
  });

  it("modify metadata-only — no reconnect, category updated", async () => {
    const config1 = makeConfig({
      alpha: {
        type: "streamable-http",
        url: "http://localhost:1000",
        _bridge: { category: "old-category" },
      },
    });
    mockServers.set("alpha", createMockServer([makeTool("tool")]));

    upstreamManager = new UpstreamManager({
      config: config1,
      toolRegistry,
      logger,
      _clientFactory: clientFactory,
    });

    await upstreamManager.connectAll();
    const clientBefore = upstreamManager.getClient("alpha");
    expect(toolRegistry.getCategoryForSource("alpha")).toBe("old-category");

    // Change only metadata
    const config2 = makeConfig({
      alpha: {
        type: "streamable-http",
        url: "http://localhost:1000",
        _bridge: { category: "new-category" },
      },
    });

    const diff = diffConfigs(config1, config2);
    expect(diff.servers.updated).toHaveLength(1);
    expect(diff.servers.reconnect).toHaveLength(0);

    await upstreamManager.applyConfigDiff(diff, config2);

    // Same client, no reconnect
    const clientAfter = upstreamManager.getClient("alpha");
    expect(clientAfter).toBe(clientBefore);
    expect(toolRegistry.getCategoryForSource("alpha")).toBe("new-category");
  });

  it("removing category via metadata update clears it from registry", async () => {
    const config1 = makeConfig({
      alpha: {
        type: "streamable-http",
        url: "http://localhost:1000",
        _bridge: { category: "devtools" },
      },
    });
    mockServers.set("alpha", createMockServer([makeTool("tool")]));

    upstreamManager = new UpstreamManager({
      config: config1,
      toolRegistry,
      logger,
      _clientFactory: clientFactory,
    });

    await upstreamManager.connectAll();
    expect(toolRegistry.getCategoryForSource("alpha")).toBe("devtools");

    // Remove category entirely
    const config2 = makeConfig({
      alpha: {
        type: "streamable-http",
        url: "http://localhost:1000",
        _bridge: {},
      },
    });

    const diff = diffConfigs(config1, config2);
    expect(diff.servers.updated).toHaveLength(1);

    await upstreamManager.applyConfigDiff(diff, config2);
    expect(toolRegistry.getCategoryForSource("alpha")).toBeUndefined();
  });

  it("invalid config diff produces empty diff, no crash", () => {
    const config = makeConfig({
      alpha: { type: "streamable-http", url: "http://localhost:1000" },
    });

    // Same config → empty diff
    const diff = diffConfigs(config, config);

    expect(diff.servers.added).toHaveLength(0);
    expect(diff.servers.removed).toHaveLength(0);
    expect(diff.servers.reconnect).toHaveLength(0);
    expect(diff.servers.updated).toHaveLength(0);
    expect(diff.bridge.requiresRestart).toHaveLength(0);
  });

  it("bridge logLevel change updates via setLevel", () => {
    const logger = createLogger({ level: "error", format: "text" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // Should be suppressed at error level
    logger.info("hidden");
    expect(stderrSpy).not.toHaveBeenCalled();

    // Simulate what the reload handler does
    logger.setLevel("debug");
    logger.info("visible");
    expect(stderrSpy).toHaveBeenCalledTimes(1);

    stderrSpy.mockRestore();
  });

  it("bridge healthCheckInterval change restarts health checks", async () => {
    const config1 = makeConfig({}, { healthCheckInterval: 30 });
    mockServers.set("alpha", createMockServer([makeTool("tool")]));

    upstreamManager = new UpstreamManager({
      config: config1,
      toolRegistry,
      logger,
      _clientFactory: clientFactory,
    });

    await upstreamManager.connectAll();
    upstreamManager.startHealthChecks();

    // Restart with new interval
    upstreamManager.restartHealthChecks(60);

    // Just verify it doesn't throw and we can stop cleanly
    upstreamManager.stopHealthChecks();
  });

  it("bridge toolPolicy change updates PolicyEngine", () => {
    policyEngine = new PolicyEngine("always", {
      alpha: { toolPolicy: "prompt" },
    });

    expect(policyEngine.resolvePolicy("alpha", "tool")).toBe("prompt");
    expect(policyEngine.resolvePolicy("beta", "tool")).toBe("always");

    // Simulate reload
    policyEngine.update("never", {
      alpha: { toolPolicy: "always" },
    });

    expect(policyEngine.resolvePolicy("alpha", "tool")).toBe("always");
    expect(policyEngine.resolvePolicy("beta", "tool")).toBe("never");
  });
});
