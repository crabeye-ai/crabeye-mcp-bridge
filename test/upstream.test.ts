import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BridgeConfigSchema, type BridgeConfig } from "../src/config/schema.js";
import { HttpUpstreamClient } from "../src/upstream/http-client.js";
import { StdioUpstreamClient } from "../src/upstream/stdio-client.js";
import { UpstreamManager } from "../src/upstream/upstream-manager.js";
import { ToolRegistry } from "../src/server/tool-registry.js";
import type { StatusChangeEvent } from "../src/upstream/types.js";

function makeTool(name: string, description?: string): Tool {
  return {
    name,
    description: description ?? `Tool ${name}`,
    inputSchema: { type: "object" as const },
  };
}

function createMockServer(tools: Tool[], toolHandler?: (name: string, args: Record<string, unknown>) => CallToolResult) {
  const server = new Server(
    { name: "mock-upstream", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );

  let currentTools = tools;

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return { tools: currentTools };
  });

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params;
    if (toolHandler) {
      return toolHandler(name, (args ?? {}) as Record<string, unknown>);
    }
    return {
      content: [{ type: "text" as const, text: `Called ${name}` }],
    };
  });

  return {
    server,
    setTools(newTools: Tool[]) {
      currentTools = newTools;
    },
  };
}

function createLinkedClient(
  name: string,
  mockServer: Server,
  options?: Partial<ConstructorParameters<typeof HttpUpstreamClient>[0]>,
): { client: HttpUpstreamClient; serverTransport: Transport } {
  let serverTransport: Transport;

  const client = new HttpUpstreamClient({
    name,
    config: {
      type: "streamable-http",
      url: "http://localhost:9999",
    },
    ...options,
    _transportFactory: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      serverTransport = serverSide;
      mockServer.connect(serverSide);
      return clientSide;
    },
  });

  return { client, get serverTransport() { return serverTransport!; } };
}

function createLinkedStdioClient(
  name: string,
  mockServer: Server,
  options?: Partial<ConstructorParameters<typeof StdioUpstreamClient>[0]>,
): { client: StdioUpstreamClient; serverTransport: Transport } {
  let serverTransport: Transport;

  const client = new StdioUpstreamClient({
    name,
    config: { command: "node", args: ["server.js"] },
    ...options,
    _transportFactory: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      serverTransport = serverSide;
      mockServer.connect(serverSide);
      return clientSide;
    },
  });

  return { client, get serverTransport() { return serverTransport!; } };
}

// --- HttpUpstreamClient ---

describe("HttpUpstreamClient", () => {
  let mockServerHandle: ReturnType<typeof createMockServer>;
  let upstreamClient: HttpUpstreamClient;

  beforeEach(() => {
    mockServerHandle = createMockServer([
      makeTool("tool-a", "First tool"),
      makeTool("tool-b", "Second tool"),
    ]);
  });

  afterEach(async () => {
    await upstreamClient?.close().catch(() => {});
    await mockServerHandle?.server.close().catch(() => {});
  });

  it("connects and discovers tools from mock server", async () => {
    const { client } = createLinkedClient("test", mockServerHandle.server);
    upstreamClient = client;

    await client.connect();

    expect(client.status).toBe("connected");
    expect(client.tools).toHaveLength(2);
    expect(client.tools.map((t) => t.name).sort()).toEqual(["tool-a", "tool-b"]);
  });

  it("callTool delegates to upstream and returns result", async () => {
    mockServerHandle = createMockServer(
      [makeTool("echo")],
      (name, args) => ({
        content: [{ type: "text", text: `echo: ${JSON.stringify(args)}` }],
      }),
    );

    const { client } = createLinkedClient("test", mockServerHandle.server);
    upstreamClient = client;
    await client.connect();

    const result = await client.callTool({
      name: "echo",
      arguments: { msg: "hello" },
    });

    expect(result.content).toEqual([
      { type: "text", text: 'echo: {"msg":"hello"}' },
    ]);
  });

  it("callTool throws when disconnected", async () => {
    const { client } = createLinkedClient("test", mockServerHandle.server);
    upstreamClient = client;

    await expect(
      client.callTool({ name: "tool-a" }),
    ).rejects.toThrow(/not connected/);
  });

  it("close() sets status to disconnected and clears tools", async () => {
    const { client } = createLinkedClient("test", mockServerHandle.server);
    upstreamClient = client;

    await client.connect();
    expect(client.tools).toHaveLength(2);

    await client.close();

    expect(client.status).toBe("disconnected");
    expect(client.tools).toHaveLength(0);
  });

  it("onStatusChange fires on connecting → connected → disconnected transitions", async () => {
    const { client } = createLinkedClient("test", mockServerHandle.server);
    upstreamClient = client;

    const events: StatusChangeEvent[] = [];
    client.onStatusChange((event) => events.push({ ...event }));

    await client.connect();
    await client.close();

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ previous: "disconnected", current: "connecting" });
    expect(events[1]).toEqual({ previous: "connecting", current: "connected" });
    expect(events[2]).toEqual({ previous: "connected", current: "disconnected" });
  });

  it("onToolsChanged fires on connect with initial tools", async () => {
    const { client } = createLinkedClient("test", mockServerHandle.server);
    upstreamClient = client;

    const toolSets: Tool[][] = [];
    client.onToolsChanged((tools) => toolSets.push([...tools]));

    await client.connect();

    expect(toolSets).toHaveLength(1);
    expect(toolSets[0]).toHaveLength(2);
  });

  it("upstream tools/list_changed triggers re-discovery", async () => {
    const { client } = createLinkedClient("test", mockServerHandle.server);
    upstreamClient = client;

    await client.connect();
    expect(client.tools).toHaveLength(2);

    // Update tools on the mock server and notify
    mockServerHandle.setTools([
      makeTool("tool-a"),
      makeTool("tool-b"),
      makeTool("tool-c"),
    ]);

    const toolsUpdated = new Promise<void>((resolve) => {
      client.onToolsChanged((tools) => {
        if (tools.length === 3) resolve();
      });
    });

    await mockServerHandle.server.sendToolListChanged();

    await expect(
      Promise.race([
        toolsUpdated,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 5000),
        ),
      ]),
    ).resolves.toBeUndefined();

    expect(client.tools).toHaveLength(3);
  });

  it("reconnects on disconnect with exponential backoff", async () => {
    vi.useFakeTimers();
    let connectCount = 0;

    const { client } = createLinkedClient("test", mockServerHandle.server, {
      maxReconnectAttempts: 3,
      reconnectBaseDelay: 100,
      reconnectMaxDelay: 1000,
    });
    upstreamClient = client;

    // Track connect calls via status changes
    client.onStatusChange((event) => {
      if (event.current === "connecting") connectCount++;
    });

    await client.connect();
    expect(connectCount).toBe(1);

    // Simulate upstream disconnect by closing the server
    await mockServerHandle.server.close();

    // Wait for the onclose callback to fire
    await vi.advanceTimersByTimeAsync(0);

    // First reconnect: delay = 100ms * 2^0 = 100ms
    await vi.advanceTimersByTimeAsync(100);
    // connect() will fail since server is closed, that's OK for this test

    // Second reconnect: delay = 100ms * 2^1 = 200ms
    await vi.advanceTimersByTimeAsync(200);

    // Should have attempted reconnection
    expect(connectCount).toBeGreaterThan(1);

    vi.useRealTimers();
  });

  it("gives up after max reconnect attempts → status error", async () => {
    vi.useFakeTimers();

    let shouldFail = false;
    let clientTransport: Transport | undefined;

    const client = new HttpUpstreamClient({
      name: "test",
      config: { type: "streamable-http", url: "http://localhost:9999" },
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 50,
      reconnectMaxDelay: 200,
      _transportFactory: () => {
        if (shouldFail) {
          // Minimal Transport stub — start() throws before any callbacks fire
          return {
            async start() { throw new Error("Connection refused"); },
            async send() {},
            async close() {},
          };
        }
        const [cSide, sSide] = InMemoryTransport.createLinkedPair();
        const srv = new Server(
          { name: "temp", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        srv.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        srv.connect(sSide);
        clientTransport = cSide;
        return cSide;
      },
    });
    upstreamClient = client;

    const statusHistory: string[] = [];
    client.onStatusChange((event) => statusHistory.push(event.current));

    // First connect succeeds
    await client.connect();
    expect(client.status).toBe("connected");

    // Make all subsequent connections fail
    shouldFail = true;

    // Simulate transport closure to trigger reconnect
    clientTransport!.onclose?.();
    await vi.advanceTimersByTimeAsync(0);

    // Reconnect attempt 1: delay = 50ms * 2^0 = 50ms
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);

    // Reconnect attempt 2: delay = 50ms * 2^1 = 100ms
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.status).toBe("error");
    expect(statusHistory).toContain("error");

    vi.useRealTimers();
  });

  it("onStatusChange unsubscribe stops notifications", async () => {
    const { client } = createLinkedClient("test", mockServerHandle.server);
    upstreamClient = client;

    const events: StatusChangeEvent[] = [];
    const unsub = client.onStatusChange((event) => events.push(event));

    await client.connect();
    expect(events).toHaveLength(2); // connecting, connected

    unsub();
    await client.close();
    expect(events).toHaveLength(2); // No new events
  });

  it("concurrent connect() calls coalesce into a single connection", async () => {
    let factoryCalls = 0;

    const client = new HttpUpstreamClient({
      name: "test",
      config: { type: "streamable-http", url: "http://localhost:9999" },
      _transportFactory: () => {
        factoryCalls++;
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        mockServerHandle.server.connect(serverSide);
        return clientSide;
      },
    });
    upstreamClient = client;

    const p1 = client.connect();
    const p2 = client.connect();

    await Promise.all([p1, p2]);

    expect(factoryCalls).toBe(1);
    expect(client.status).toBe("connected");
  });

  it("connect() failure sets status to disconnected, not stuck on connecting", async () => {
    const client = new HttpUpstreamClient({
      name: "test",
      config: { type: "streamable-http", url: "http://localhost:9999" },
      maxReconnectAttempts: 0,
      _transportFactory: () => ({
        async start() { throw new Error("Connection refused"); },
        async send() {},
        async close() {},
      }),
    });
    upstreamClient = client;

    await client.connect().catch(() => {});

    expect(client.status).toBe("disconnected");
  });
});

// --- UpstreamManager ---

describe("UpstreamManager", () => {
  let toolRegistry: ToolRegistry;

  beforeEach(() => {
    toolRegistry = new ToolRegistry();
  });

  function makeConfig(servers: Record<string, unknown>): BridgeConfig {
    return {
      mcpServers: servers,
      _bridge: {
        port: 19875,
        logLevel: "info",
        maxUpstreamConnections: 1000,
        connectionTimeout: 30,
        idleTimeout: 600,
      },
    } as BridgeConfig;
  }

  it("connectAll connects HTTP servers and feeds tools into ToolRegistry", async () => {
    const mockServer = createMockServer([makeTool("remote-tool")]);

    const config = makeConfig({
      "my-server": { type: "streamable-http", url: "http://localhost:9999" },
    });

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => createLinkedClient(name, mockServer.server).client,
    });

    await manager.connectAll();

    expect(toolRegistry.listTools()).toHaveLength(1);
    expect(toolRegistry.getTool("my-server__remote-tool")).toBeDefined();
    expect(toolRegistry.getTool("my-server__remote-tool")!.source).toBe("my-server");

    await manager.closeAll();
    await mockServer.server.close();
  });

  it("connectAll connects STDIO servers and feeds tools into ToolRegistry", async () => {
    const mockServer = createMockServer([makeTool("local-tool")]);

    const config = makeConfig({
      "my-stdio": { command: "node", args: ["server.js"] },
    });

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => createLinkedStdioClient(name, mockServer.server).client,
    });

    await manager.connectAll();

    expect(toolRegistry.listTools()).toHaveLength(1);
    expect(toolRegistry.getTool("my-stdio__local-tool")).toBeDefined();
    expect(toolRegistry.getTool("my-stdio__local-tool")!.source).toBe("my-stdio");

    await manager.closeAll();
    await mockServer.server.close();
  });

  it("mixed HTTP + STDIO configs both connect", async () => {
    const httpServer = createMockServer([makeTool("http-tool")]);
    const stdioServer = createMockServer([makeTool("stdio-tool")]);

    const config = makeConfig({
      "remote": { type: "streamable-http", url: "http://localhost:9999" },
      "local": { command: "node", args: ["server.js"] },
    });

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => {
        if (name === "remote") {
          return createLinkedClient(name, httpServer.server).client;
        }
        return createLinkedStdioClient(name, stdioServer.server).client;
      },
    });

    await manager.connectAll();

    expect(toolRegistry.listTools()).toHaveLength(2);
    expect(toolRegistry.getTool("remote__http-tool")).toBeDefined();
    expect(toolRegistry.getTool("local__stdio-tool")).toBeDefined();
    expect(manager.getClient("remote")!.status).toBe("connected");
    expect(manager.getClient("local")!.status).toBe("connected");

    await manager.closeAll();
    await httpServer.server.close();
    await stdioServer.server.close();
  });

  it("tools removed from ToolRegistry when upstream reaches error state", async () => {
    const mockServer = createMockServer([makeTool("tool-x")]);

    const config = makeConfig({
      "upstream-a": { type: "streamable-http", url: "http://localhost:9999" },
    });

    let clientRef: HttpUpstreamClient | undefined;
    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => {
        const { client } = createLinkedClient(name, mockServer.server, {
          maxReconnectAttempts: 0,
        });
        clientRef = client;
        return client;
      },
    });

    await manager.connectAll();
    expect(toolRegistry.listTools()).toHaveLength(1);

    // With maxReconnectAttempts=0, disconnect → scheduleReconnect → immediately error
    const errorReached = new Promise<void>((resolve) => {
      clientRef!.onStatusChange((event) => {
        if (event.current === "error") resolve();
      });
    });

    await mockServer.server.close();

    await Promise.race([
      errorReached,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout waiting for error")), 2000),
      ),
    ]);

    expect(toolRegistry.listTools()).toHaveLength(0);

    await manager.closeAll();
  });

  it("tools preserved in ToolRegistry on transient upstream disconnect", async () => {
    const mockServer = createMockServer([makeTool("tool-x")]);

    const config = makeConfig({
      "upstream-a": { type: "streamable-http", url: "http://localhost:9999" },
    });

    let clientRef: HttpUpstreamClient | undefined;
    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => {
        const { client } = createLinkedClient(name, mockServer.server, {
          maxReconnectAttempts: 3,
        });
        clientRef = client;
        return client;
      },
    });

    await manager.connectAll();
    expect(toolRegistry.listTools()).toHaveLength(1);

    // Wait for the client to enter disconnected state
    const disconnected = new Promise<void>((resolve) => {
      clientRef!.onStatusChange((event) => {
        if (event.current === "disconnected") resolve();
      });
    });

    await mockServer.server.close();
    await disconnected;

    // Client is disconnected but will attempt to reconnect — tools stay in registry
    expect(clientRef!.status).not.toBe("connected");
    expect(toolRegistry.listTools()).toHaveLength(1);

    await manager.closeAll();
  });

  it("individual server failure does not block others", async () => {
    const serverB = createMockServer([makeTool("tool-from-b")]);

    const config = makeConfig({
      "server-a": { type: "streamable-http", url: "http://localhost:1111" },
      "server-b": { type: "streamable-http", url: "http://localhost:2222" },
    });

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => {
        if (name === "server-a") {
          return new HttpUpstreamClient({
            name,
            config: { type: "streamable-http", url: "http://localhost:1111" },
            maxReconnectAttempts: 0,
            _transportFactory: () => ({
              async start() { throw new Error("Connection refused"); },
              async send() {},
              async close() {},
            }),
          });
        }
        return createLinkedClient(name, serverB.server).client;
      },
    });

    await manager.connectAll();

    expect(toolRegistry.getTool("server-b__tool-from-b")).toBeDefined();
    expect(manager.getClient("server-b")!.status).toBe("connected");

    await manager.closeAll();
    await serverB.server.close();
  });

  it("closeAll disconnects everything and clears registry", async () => {
    const mockServer = createMockServer([makeTool("some-tool")]);

    const config = makeConfig({
      "my-server": { type: "streamable-http", url: "http://localhost:9999" },
    });

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => createLinkedClient(name, mockServer.server).client,
    });

    await manager.connectAll();
    expect(toolRegistry.listTools()).toHaveLength(1);

    await manager.closeAll();

    expect(manager.getStatuses()).toEqual([]);
    expect(toolRegistry.listTools()).toHaveLength(0);

    await mockServer.server.close();
  });

  it("getClient returns correct client by name", async () => {
    const serverA = createMockServer([makeTool("tool-a")]);
    const serverB = createMockServer([makeTool("tool-b")]);
    const servers: Record<string, ReturnType<typeof createMockServer>> = {
      alpha: serverA,
      beta: serverB,
    };

    const config = makeConfig({
      "alpha": { type: "streamable-http", url: "http://localhost:1111" },
      "beta": { type: "sse", url: "http://localhost:2222" },
    });

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => createLinkedClient(name, servers[name].server).client,
    });

    await manager.connectAll();

    expect(manager.getClient("alpha")).toBeDefined();
    expect(manager.getClient("alpha")!.name).toBe("alpha");
    expect(manager.getClient("beta")).toBeDefined();
    expect(manager.getClient("beta")!.name).toBe("beta");
    expect(manager.getClient("nonexistent")).toBeUndefined();

    await manager.closeAll();
    await serverA.server.close();
    await serverB.server.close();
  });

  it("getStatuses returns name, status, and toolCount for all upstreams", async () => {
    const serverA = createMockServer([makeTool("t1"), makeTool("t2")]);
    const serverB = createMockServer([makeTool("t3")]);
    const servers: Record<string, ReturnType<typeof createMockServer>> = {
      "srv-a": serverA,
      "srv-b": serverB,
    };

    const config = makeConfig({
      "srv-a": { type: "streamable-http", url: "http://localhost:1111" },
      "srv-b": { type: "sse", url: "http://localhost:2222" },
    });

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => createLinkedClient(name, servers[name].server).client,
    });

    await manager.connectAll();

    const statuses = manager.getStatuses();
    expect(statuses).toHaveLength(2);

    const statusA = statuses.find((s) => s.name === "srv-a")!;
    expect(statusA.status).toBe("connected");
    expect(statusA.toolCount).toBe(2);

    const statusB = statuses.find((s) => s.name === "srv-b")!;
    expect(statusB.status).toBe("connected");
    expect(statusB.toolCount).toBe(1);

    await manager.closeAll();
    await serverA.server.close();
    await serverB.server.close();
  });

  it("merges mcpUpstreams and mcpServers into a union", async () => {
    const serverA = createMockServer([makeTool("tool")]);
    const serverB = createMockServer([makeTool("tool")]);
    const servers: Record<string, ReturnType<typeof createMockServer>> = {
      "from-upstreams": serverA,
      "from-mcp": serverB,
    };

    const config = BridgeConfigSchema.parse({
      mcpUpstreams: {
        "from-upstreams": { type: "streamable-http", url: "http://localhost:9999" },
      },
      mcpServers: {
        "from-mcp": { command: "node", args: ["other.js"] },
      },
    });

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => createLinkedClient(name, servers[name].server).client,
    });

    await manager.connectAll();

    expect(toolRegistry.listTools()).toHaveLength(2);
    expect(toolRegistry.getTool("from-upstreams__tool")).toBeDefined();
    expect(toolRegistry.getTool("from-mcp__tool")).toBeDefined();

    await manager.closeAll();
    await serverA.server.close();
    await serverB.server.close();
  });

  it("merges servers and mcpServers into a union", async () => {
    const serverA = createMockServer([makeTool("tool")]);
    const serverB = createMockServer([makeTool("tool")]);
    const servers: Record<string, ReturnType<typeof createMockServer>> = {
      "vscode-server": serverA,
      "mcp-server": serverB,
    };

    const config = BridgeConfigSchema.parse({
      servers: {
        "vscode-server": { type: "streamable-http", url: "http://localhost:9999" },
      },
      mcpServers: {
        "mcp-server": { command: "node", args: ["other.js"] },
      },
    });

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => createLinkedClient(name, servers[name].server).client,
    });

    await manager.connectAll();

    expect(toolRegistry.listTools()).toHaveLength(2);
    expect(toolRegistry.getTool("vscode-server__tool")).toBeDefined();
    expect(toolRegistry.getTool("mcp-server__tool")).toBeDefined();

    await manager.closeAll();
    await serverA.server.close();
    await serverB.server.close();
  });

  it("namespaces tools from multiple upstreams to avoid collisions", async () => {
    const serverA = createMockServer([makeTool("create_issue")]);
    const serverB = createMockServer([makeTool("create_issue")]);
    const servers: Record<string, ReturnType<typeof createMockServer>> = {
      linear: serverA,
      github: serverB,
    };

    const config = makeConfig({
      linear: { type: "streamable-http", url: "http://localhost:1111" },
      github: { type: "streamable-http", url: "http://localhost:2222" },
    });

    const manager = new UpstreamManager({
      config,
      toolRegistry,
      _clientFactory: (name) => createLinkedClient(name, servers[name].server).client,
    });

    await manager.connectAll();

    expect(toolRegistry.listTools()).toHaveLength(2);
    expect(toolRegistry.getTool("linear__create_issue")).toBeDefined();
    expect(toolRegistry.getTool("linear__create_issue")!.source).toBe("linear");
    expect(toolRegistry.getTool("github__create_issue")).toBeDefined();
    expect(toolRegistry.getTool("github__create_issue")!.source).toBe("github");

    await manager.closeAll();
    await serverA.server.close();
    await serverB.server.close();
  });
});

// --- StdioUpstreamClient ---

describe("StdioUpstreamClient", () => {
  let mockServerHandle: ReturnType<typeof createMockServer>;
  let upstreamClient: StdioUpstreamClient;

  beforeEach(() => {
    mockServerHandle = createMockServer([
      makeTool("tool-a", "First tool"),
      makeTool("tool-b", "Second tool"),
    ]);
  });

  afterEach(async () => {
    await upstreamClient?.close().catch(() => {});
    await mockServerHandle?.server.close().catch(() => {});
  });

  it("connects and discovers tools from mock server", async () => {
    const { client } = createLinkedStdioClient("test", mockServerHandle.server);
    upstreamClient = client;

    await client.connect();

    expect(client.status).toBe("connected");
    expect(client.tools).toHaveLength(2);
    expect(client.tools.map((t) => t.name).sort()).toEqual(["tool-a", "tool-b"]);
  });

  it("callTool delegates to upstream and returns result", async () => {
    mockServerHandle = createMockServer(
      [makeTool("echo")],
      (name, args) => ({
        content: [{ type: "text", text: `echo: ${JSON.stringify(args)}` }],
      }),
    );

    const { client } = createLinkedStdioClient("test", mockServerHandle.server);
    upstreamClient = client;
    await client.connect();

    const result = await client.callTool({
      name: "echo",
      arguments: { msg: "hello" },
    });

    expect(result.content).toEqual([
      { type: "text", text: 'echo: {"msg":"hello"}' },
    ]);
  });

  it("callTool throws when disconnected", async () => {
    const { client } = createLinkedStdioClient("test", mockServerHandle.server);
    upstreamClient = client;

    await expect(
      client.callTool({ name: "tool-a" }),
    ).rejects.toThrow(/not connected/);
  });

  it("close() sets status to disconnected and clears tools", async () => {
    const { client } = createLinkedStdioClient("test", mockServerHandle.server);
    upstreamClient = client;

    await client.connect();
    expect(client.tools).toHaveLength(2);

    await client.close();

    expect(client.status).toBe("disconnected");
    expect(client.tools).toHaveLength(0);
  });

  it("onStatusChange fires on connecting → connected → disconnected transitions", async () => {
    const { client } = createLinkedStdioClient("test", mockServerHandle.server);
    upstreamClient = client;

    const events: StatusChangeEvent[] = [];
    client.onStatusChange((event) => events.push({ ...event }));

    await client.connect();
    await client.close();

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ previous: "disconnected", current: "connecting" });
    expect(events[1]).toEqual({ previous: "connecting", current: "connected" });
    expect(events[2]).toEqual({ previous: "connected", current: "disconnected" });
  });

  it("onToolsChanged fires on connect with initial tools", async () => {
    const { client } = createLinkedStdioClient("test", mockServerHandle.server);
    upstreamClient = client;

    const toolSets: Tool[][] = [];
    client.onToolsChanged((tools) => toolSets.push([...tools]));

    await client.connect();

    expect(toolSets).toHaveLength(1);
    expect(toolSets[0]).toHaveLength(2);
  });

  it("reconnects on disconnect with exponential backoff", async () => {
    vi.useFakeTimers();
    let connectCount = 0;

    const { client } = createLinkedStdioClient("test", mockServerHandle.server, {
      maxReconnectAttempts: 3,
      reconnectBaseDelay: 100,
      reconnectMaxDelay: 1000,
    });
    upstreamClient = client;

    client.onStatusChange((event) => {
      if (event.current === "connecting") connectCount++;
    });

    await client.connect();
    expect(connectCount).toBe(1);

    // Simulate upstream disconnect by closing the server
    await mockServerHandle.server.close();

    // Wait for the onclose callback to fire
    await vi.advanceTimersByTimeAsync(0);

    // First reconnect: delay = 100ms * 2^0 = 100ms
    await vi.advanceTimersByTimeAsync(100);

    // Second reconnect: delay = 100ms * 2^1 = 200ms
    await vi.advanceTimersByTimeAsync(200);

    expect(connectCount).toBeGreaterThan(1);

    vi.useRealTimers();
  });

  it("gives up after max reconnect attempts → status error", async () => {
    vi.useFakeTimers();

    let shouldFail = false;
    let clientTransport: Transport | undefined;

    const client = new StdioUpstreamClient({
      name: "test",
      config: { command: "node", args: ["server.js"] },
      maxReconnectAttempts: 2,
      reconnectBaseDelay: 50,
      reconnectMaxDelay: 200,
      _transportFactory: () => {
        if (shouldFail) {
          return {
            async start() { throw new Error("Connection refused"); },
            async send() {},
            async close() {},
          };
        }
        const [cSide, sSide] = InMemoryTransport.createLinkedPair();
        const srv = new Server(
          { name: "temp", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        srv.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
        srv.connect(sSide);
        clientTransport = cSide;
        return cSide;
      },
    });
    upstreamClient = client;

    const statusHistory: string[] = [];
    client.onStatusChange((event) => statusHistory.push(event.current));

    await client.connect();
    expect(client.status).toBe("connected");

    shouldFail = true;

    clientTransport!.onclose?.();
    await vi.advanceTimersByTimeAsync(0);

    // Reconnect attempt 1: delay = 50ms * 2^0 = 50ms
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);

    // Reconnect attempt 2: delay = 50ms * 2^1 = 100ms
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(0);

    expect(client.status).toBe("error");
    expect(statusHistory).toContain("error");

    vi.useRealTimers();
  });

  it("concurrent connect() calls coalesce into a single connection", async () => {
    let factoryCalls = 0;

    const client = new StdioUpstreamClient({
      name: "test",
      config: { command: "node", args: ["server.js"] },
      _transportFactory: () => {
        factoryCalls++;
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        mockServerHandle.server.connect(serverSide);
        return clientSide;
      },
    });
    upstreamClient = client;

    const p1 = client.connect();
    const p2 = client.connect();

    await Promise.all([p1, p2]);

    expect(factoryCalls).toBe(1);
    expect(client.status).toBe("connected");
  });

  it("connect() failure sets status to disconnected, not stuck on connecting", async () => {
    const client = new StdioUpstreamClient({
      name: "test",
      config: { command: "node", args: ["server.js"] },
      maxReconnectAttempts: 0,
      _transportFactory: () => ({
        async start() { throw new Error("Connection refused"); },
        async send() {},
        async close() {},
      }),
    });
    upstreamClient = client;

    await client.connect().catch(() => {});

    expect(client.status).toBe("disconnected");
  });
});
