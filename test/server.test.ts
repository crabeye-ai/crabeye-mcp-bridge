import { describe, it, expect, beforeEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { Client, InMemoryTransport, ProtocolErrorCode } from "@modelcontextprotocol/client";
import type { Tool, CallToolResult } from "@modelcontextprotocol/client";
import { APP_VERSION } from "../src/constants.js";
import { ToolRegistry } from "../src/server/tool-registry.js";
import { BridgeServer } from "../src/server/bridge-server.js";
import type { UpstreamClient } from "../src/upstream/types.js";
import { createTestPair, makeMockUpstreamClient, makeTool } from "./_helpers/bridge-test-pair.js";
import { viaRunTool } from "./_helpers/run-tool.js";
import { runToolDefinition, searchToolDefinition } from "../src/search/index.js";
import { PolicyEngine } from "../src/policy/index.js";
import {
  NAMESPACE_SEPARATOR,
  namespaceTool,
  parseNamespacedName,
} from "../src/server/tool-namespacing.js";

const BRIDGE_TOOLS = [searchToolDefinition, runToolDefinition];

// --- ToolRegistry ---

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("starts empty", () => {
    expect(registry.listTools()).toEqual([]);
    expect(registry.getTool("anything")).toBeUndefined();
  });

  it("stores and retrieves tools by name with source tracking", () => {
    const tool = makeTool("my-tool", "A test tool");
    registry.setToolsForSource("server-a", [tool]);

    expect(registry.listTools()).toHaveLength(1);
    expect(registry.listTools()[0].name).toBe("my-tool");

    const registered = registry.getTool("my-tool");
    expect(registered).toBeDefined();
    expect(registered!.source).toBe("server-a");
    expect(registered!.tool.name).toBe("my-tool");
  });

  it("setToolsForSource replaces previous tools from same source", () => {
    registry.setToolsForSource("server-a", [makeTool("tool-1"), makeTool("tool-2")]);
    expect(registry.listTools()).toHaveLength(2);

    registry.setToolsForSource("server-a", [makeTool("tool-3")]);
    expect(registry.listTools()).toHaveLength(1);
    expect(registry.getTool("tool-1")).toBeUndefined();
    expect(registry.getTool("tool-2")).toBeUndefined();
    expect(registry.getTool("tool-3")).toBeDefined();
  });

  it("removeSource clears tools and fires callback", () => {
    const callback = vi.fn();
    registry.onChanged(callback);

    registry.setToolsForSource("server-a", [makeTool("tool-1")]);
    callback.mockClear();

    registry.removeSource("server-a");
    expect(registry.listTools()).toHaveLength(0);
    expect(registry.getTool("tool-1")).toBeUndefined();
    expect(callback).toHaveBeenCalledOnce();
  });

  it("removeSource does not fire callback if source had no tools", () => {
    const callback = vi.fn();
    registry.onChanged(callback);

    registry.removeSource("nonexistent");
    expect(callback).not.toHaveBeenCalled();
  });

  it("removeSource does not delete tools that were overwritten by another source", () => {
    registry.setToolsForSource("server-a", [makeTool("shared-tool")]);
    registry.setToolsForSource("server-b", [makeTool("shared-tool")]);

    // server-b now owns "shared-tool"; removing server-a should not delete it
    registry.removeSource("server-a");

    const registered = registry.getTool("shared-tool");
    expect(registered).toBeDefined();
    expect(registered!.source).toBe("server-b");
  });

  it("observer subscribe/unsubscribe works", () => {
    const callback = vi.fn();
    const unsubscribe = registry.onChanged(callback);

    registry.setToolsForSource("server-a", [makeTool("tool-1")]);
    expect(callback).toHaveBeenCalledOnce();

    unsubscribe();
    registry.setToolsForSource("server-a", [makeTool("tool-2")]);
    expect(callback).toHaveBeenCalledOnce(); // still 1, not 2
  });
});

// --- BridgeServer initialize ---

describe("BridgeServer initialize", () => {
  it("completes handshake and reports server name/version", async () => {
    const { client, cleanup } = await createTestPair();

    const serverInfo = client.getServerVersion();
    expect(serverInfo).toBeDefined();
    expect(serverInfo!.name).toBe("crabeye-mcp-bridge");
    expect(serverInfo!.version).toBe(APP_VERSION);

    await cleanup();
  });

  it.each([false, true])("advertises tools without declaring that the list can change (modern: %s)", async (modern) => {
    const { client, cleanup } = await createTestPair({ modern });

    expect(client.getProtocolEra()).toBe(modern ? "modern" : "legacy");
    expect(client.getServerCapabilities()?.tools).toEqual({});

    await cleanup();
  });

  it.each([false, true])("points the assistant to run_tool as the only way to call upstream tools (modern: %s)", async (modern) => {
    const { client, cleanup } = await createTestPair({ modern });
    const { tools } = await client.listTools();
    const text = [client.getInstructions(), ...tools.map((tool) => tool.description)].join("\n");

    expect(text).toContain("use run_tool to execute them; it is the only way to call them");
    expect(text).not.toMatch(/auto-enabled|enabled first|directly|discovery mode|tool list|by (its|their) name|listed|until searched/i);

    await cleanup();
  });

  it("buildPassthrough output is appended to bridge instructions on initialize (AIT-183)", async () => {
    const toolRegistry = new ToolRegistry();
    const server = new BridgeServer({
      toolRegistry,
      buildPassthrough: () => "## linear\n\nUse Linear for tickets.",
    });
    const client = new Client({ name: "t", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toContain("This MCP bridge connects you");
    expect(instructions).toContain("## linear\n\nUse Linear for tickets.");
    await client.close();
    await server.close();
  });

  it("each new connection re-reads instructions, so late passthrough blocks appear (AIT-183)", async () => {
    const toolRegistry = new ToolRegistry();
    let block = "";
    const server = new BridgeServer({
      toolRegistry,
      buildPassthrough: () => block,
    });

    // First handshake: empty passthrough.
    {
      const client = new Client({ name: "t", version: "0" });
      const [c, s] = InMemoryTransport.createLinkedPair();
      await server.connect(s);
      await client.connect(c);
      const instr = client.getInstructions();
      expect(instr).toBeDefined();
      expect(instr).not.toContain("## fs");
      await client.close();
      await server.close();
    }

    block = "## fs\n\nFile-system server.";

    {
      const client = new Client({ name: "t", version: "0" });
      const [c, s] = InMemoryTransport.createLinkedPair();
      await server.connect(s);
      await client.connect(c);
      const instr = client.getInstructions();
      expect(instr).toContain("## fs");
      expect(instr).toContain("File-system server.");
      await client.close();
    }

    await server.close();
  });
});

// --- tools/list ---

describe("tools/list", () => {
  it.each([
    ["no upstream tools", []],
    ["tools from several upstreams", [["server-a", ["server-a__read-file", "server-a__write-file"]], ["server-b", ["server-b__tool-b"]]]],
  ] as const)("returns exactly search_tools and run_tool with %s registered", async (_case, sources) => {
    const registry = new ToolRegistry();
    for (const [source, names] of sources) registry.setToolsForSource(source, names.map((name) => makeTool(name)));

    const { client, cleanup } = await createTestPair({ registry });

    expect((await client.listTools()).tools).toEqual(BRIDGE_TOOLS);

    await cleanup();
  });

  it("keeps the same list and sends no notification as upstreams come and go and the assistant searches (legacy era)", async () => {
    const registry = new ToolRegistry();
    const { client, cleanup, notificationsFromServer } = await createTestPair({ registry });
    const before = (await client.listTools()).tools;

    registry.setToolsForSource("linear", [makeTool("linear__create_issue"), makeTool("linear__list_issues")]);
    await client.callTool({ name: "search_tools", arguments: { queries: [{ tool: "issue" }] } });
    await client.callTool({ name: "search_tools", arguments: { queries: [{ provider: "linear", expand_tools: true }] } });
    registry.setToolsForSource("linear", [makeTool("linear__create_issue")]);
    registry.removeSource("linear");

    expect((await client.listTools()).tools).toEqual(before);
    expect(before).toEqual(BRIDGE_TOOLS);
    expect(notificationsFromServer()).toEqual([]);

    await cleanup();
  });

  it("grants no tool-list subscription and sends no change as upstreams come and go and the assistant searches (modern era)", async () => {
    const registry = new ToolRegistry();
    const { client, cleanup, notificationsFromServer } = await createTestPair({ registry, modern: true });
    const subscription = await client.listen({ toolsListChanged: true });
    const acknowledgements = notificationsFromServer();

    registry.setToolsForSource("linear", [makeTool("linear__create_issue"), makeTool("linear__list_issues")]);
    await client.callTool({ name: "search_tools", arguments: { queries: [{ tool: "issue" }] } });
    await client.callTool({ name: "search_tools", arguments: { queries: [{ provider: "linear", expand_tools: true }] } });
    registry.setToolsForSource("linear", [makeTool("linear__create_issue")]);
    registry.removeSource("linear");

    expect(subscription.honoredFilter).toEqual({});
    expect(acknowledgements.map((message) => "method" in message && message.method)).toEqual(["notifications/subscriptions/acknowledged"]);
    expect((await client.listTools()).tools).toEqual(BRIDGE_TOOLS);
    expect(notificationsFromServer()).toEqual(acknowledgements);

    await subscription.close();
    await cleanup();
  });
});

// --- search_tools ---

describe("search_tools", () => {
  it("searches with the bridge's own policy when no search service is given", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("linear", [makeTool("linear__create_issue"), makeTool("linear__delete_issue")]);
    const { client, cleanup } = await createTestPair({
      registry,
      policyEngine: new PolicyEngine("always", { linear: { toolPolicy: "always", tools: { delete_issue: "never" } } }),
    });

    const result = await client.callTool({ name: "search_tools", arguments: { queries: [{ provider: "linear", expand_tools: true }] } });
    const tools = JSON.parse((result.content as Array<{ text: string }>)[0]!.text).results[0].providers[0].tools as Array<{ tool_name: string; disabled?: boolean }>;

    expect(tools.map(({ tool_name, disabled }) => [tool_name, disabled ?? false])).toEqual([
      ["linear__create_issue", false],
      ["linear__delete_issue", true],
    ]);

    await cleanup();
  });
});

// --- tools/call ---

describe("tools/call", () => {
  describe.each([false, true])("direct calls (modern: %s)", (modern) => {
    it.each([
      ["a registered upstream tool", "linear__create_issue", 'Call "linear__create_issue" through run_tool: { "name": "linear__create_issue", "arguments": { ... } }.'],
      ["a policy-denied upstream tool", "linear__delete_issue", 'Call "linear__delete_issue" through run_tool: { "name": "linear__delete_issue", "arguments": { ... } }.'],
      ["an unknown namespaced tool", "linear__nope", 'Call "linear__nope" through run_tool: { "name": "linear__nope", "arguments": { ... } }.'],
      ["a name with quotes", 'linear__say"hi"', 'Call "linear__say\\"hi\\"" through run_tool: { "name": "linear__say\\"hi\\"", "arguments": { ... } }.'],
      ["a name without a namespace", "nonexistent", 'Unknown tool "nonexistent"; call upstream tools through run_tool.'],
    ])("refuses a direct call of %s without reaching any upstream", async (_case, name, advice) => {
      const registry = new ToolRegistry();
      registry.setToolsForSource("linear", [makeTool("linear__create_issue"), makeTool("linear__delete_issue")]);
      const upstream = makeMockUpstreamClient("linear");
      const { client, cleanup } = await createTestPair({
        registry,
        modern,
        getUpstreamClient: () => upstream,
        policyEngine: new PolicyEngine("always", { linear: { toolPolicy: "always", tools: { delete_issue: "never" } } }),
      });

      await expect(client.callTool({ name, arguments: { title: "Bug" } })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: `${advice} This bridge's only tools are search_tools and run_tool.`,
      });
      expect(upstream.callTool).not.toHaveBeenCalled();

      await cleanup();
    });
  });

  it("routes call to correct upstream and returns result", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("linear", [makeTool("linear__create_issue")]);

    const mockClient = makeMockUpstreamClient("linear", {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "issue created" }],
      } satisfies CallToolResult),
    });

    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: (name) => (name === "linear" ? mockClient : undefined),
    });

    const result = await client.callTool(viaRunTool("linear__create_issue", { title: "Bug" }));

    expect(result.content).toEqual([{ type: "text", text: "issue created" }]);
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "create_issue",
      arguments: { title: "Bug" },
    }, { signal: expect.any(AbortSignal) });

    await cleanup();
  });

  it("routes to correct upstream when multiple upstreams exist", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("linear", [makeTool("linear__create_issue")]);
    registry.setToolsForSource("github", [makeTool("github__create_issue")]);

    const linearClient = makeMockUpstreamClient("linear", {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "linear issue" }],
      } satisfies CallToolResult),
    });
    const githubClient = makeMockUpstreamClient("github", {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "github issue" }],
      } satisfies CallToolResult),
    });

    const clients: Record<string, UpstreamClient> = { linear: linearClient, github: githubClient };
    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: (name) => clients[name],
    });

    const result = await client.callTool(viaRunTool("github__create_issue"));

    expect(result.content).toEqual([{ type: "text", text: "github issue" }]);
    expect(githubClient.callTool).toHaveBeenCalledWith({ name: "create_issue", arguments: {} }, { signal: expect.any(AbortSignal) });
    expect(linearClient.callTool).not.toHaveBeenCalled();

    await cleanup();
  });

  it("throws error when upstream server is not found", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("gone", [makeTool("gone__my-tool")]);

    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: () => undefined,
    });

    await expect(
      client.callTool(viaRunTool("gone__my-tool")),
    ).rejects.toThrow(/Upstream server not found: gone/);

    await cleanup();
  });

  it("tells the caller to re-authorize when the upstream is still paused for authorization", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__my-tool")]);
    const mockClient = makeMockUpstreamClient("srv", { status: "auth_required" });

    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: () => mockClient,
    });

    await expect(
      client.callTool(viaRunTool("srv__my-tool")),
    ).rejects.toThrow(/needs re-authorization\. Run: crabeye-mcp-bridge auth srv/);
    expect(mockClient.retryNow).toHaveBeenCalledOnce();
    expect(mockClient.callTool).not.toHaveBeenCalled();

    await cleanup();
  });

  it("runs the tool once a paused upstream reconnects after re-authorization", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__my-tool")]);
    const mockClient: UpstreamClient = makeMockUpstreamClient("srv", {
      status: "auth_required",
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
      retryNow: vi.fn(async () => {
        (mockClient as { status: string }).status = "connected";
      }),
    });

    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: () => mockClient,
    });

    const result = await client.callTool(viaRunTool("srv__my-tool"));
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);

    await cleanup();
  });

  it("keeps waiting instead of blaming authorization when a paused upstream's retry fails for another reason", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__my-tool")]);
    const statusListeners = new Set<(event: { previous: string; current: string }) => void>();
    const mockClient: UpstreamClient = makeMockUpstreamClient("srv", {
      status: "auth_required",
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
      retryNow: vi.fn(async () => {
        (mockClient as { status: string }).status = "disconnected";
      }),
      onStatusChange: vi.fn((cb) => {
        statusListeners.add(cb);
        return () => { statusListeners.delete(cb); };
      }),
    });

    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: () => mockClient,
    });

    const callPromise = client.callTool(viaRunTool("srv__my-tool"));
    await vi.waitFor(() => expect(statusListeners.size).toBe(1));
    (mockClient as { status: string }).status = "connected";
    for (const cb of statusListeners) cb({ previous: "disconnected", current: "connected" });

    const result = await callPromise;
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);

    await cleanup();
  });

  it("returns the 'reconnecting' error after waiting 30s for an upstream that stays down", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__my-tool")]);
    let retryRequested: () => void = () => {};
    const retried = new Promise<void>((r) => (retryRequested = r));
    const mockClient = makeMockUpstreamClient("srv", {
      status: "disconnected",
      retryNow: vi.fn(async () => retryRequested()),
    });
    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: () => mockClient,
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      let settled = false;
      const callPromise = client
        .callTool(viaRunTool("srv__my-tool"), { timeout: 120_000 })
        .finally(() => (settled = true));
      const assertion = expect(callPromise).rejects.toThrow(
        /Upstream server "srv" is unavailable; reconnecting in the background/,
      );
      await retried;

      await vi.advanceTimersByTimeAsync(29_990);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await assertion;
      expect(mockClient.callTool).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await cleanup();
    }
  });

  it("waits for reconnection and succeeds when server comes back", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__my-tool")]);

    const statusListeners = new Set<(event: { previous: string; current: string }) => void>();
    const mockClient = makeMockUpstreamClient("srv", {
      status: "disconnected",
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
      }),
      onStatusChange: vi.fn((cb) => {
        statusListeners.add(cb);
        return () => { statusListeners.delete(cb); };
      }),
    });

    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: () => mockClient,
    });

    // Start the tool call — it will wait for reconnection
    const callPromise = client.callTool(viaRunTool("srv__my-tool"));

    await vi.waitFor(() => expect(mockClient.retryNow).toHaveBeenCalledOnce());
    (mockClient as { status: string }).status = "connected";
    for (const cb of statusListeners) {
      cb({ previous: "disconnected", current: "connected" });
    }

    const result = await callPromise;
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);

    await cleanup();
  });

  it("stops waiting and asks for re-authorization when the reconnect needs it", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__my-tool")]);

    const statusListeners = new Set<(event: { previous: string; current: string }) => void>();
    const mockClient = makeMockUpstreamClient("srv", {
      status: "disconnected",
      onStatusChange: vi.fn((cb) => {
        statusListeners.add(cb);
        return () => { statusListeners.delete(cb); };
      }),
    });

    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: () => mockClient,
    });

    const callPromise = client.callTool(viaRunTool("srv__my-tool"));

    await vi.waitFor(() => expect(statusListeners.size).toBe(1));
    (mockClient as { status: string }).status = "auth_required";
    for (const cb of statusListeners) {
      cb({ previous: "disconnected", current: "auth_required" });
    }

    await expect(callPromise).rejects.toThrow(/needs re-authorization/);

    await cleanup();
  });

  it("tells the caller to re-authorize when their tool call is what paused the upstream", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__my-tool")]);
    const mockClient: UpstreamClient = makeMockUpstreamClient("srv", {
      callTool: vi.fn(async () => {
        (mockClient as { status: string }).status = "auth_required";
        throw new Error("Server returned 401 after re-authentication");
      }),
    });
    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: () => mockClient,
    });

    await expect(
      client.callTool(viaRunTool("srv__my-tool")),
    ).rejects.toThrow(/needs re-authorization\. Run: crabeye-mcp-bridge auth srv/);

    await cleanup();
  });

  it("wraps upstream callTool errors with server name", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("flaky", [makeTool("flaky__broken")]);

    const mockClient = makeMockUpstreamClient("flaky", {
      callTool: vi.fn().mockRejectedValue(new Error("connection reset")),
    });

    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: () => mockClient,
    });

    await expect(
      client.callTool(viaRunTool("flaky__broken")),
    ).rejects.toThrow(/Upstream server "flaky" error: connection reset/);

    await cleanup();
  });

  it("throws error when tool has no namespace separator", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("server-a", [makeTool("no-namespace")]);

    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: () => makeMockUpstreamClient("server-a"),
    });

    await expect(
      client.callTool(viaRunTool("no-namespace")),
    ).rejects.toThrow(/missing namespace/);

    await cleanup();
  });

  it("throws error when no upstream client resolver is configured", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__tool")]);

    const { client, cleanup } = await createTestPair({ registry });

    await expect(
      client.callTool(viaRunTool("srv__tool")),
    ).rejects.toThrow(/No upstream client resolver/);

    await cleanup();
  });
});

// --- Tool Namespacing ---

describe("namespaceTool", () => {
  it("produces correct prefixed name", () => {
    const tool = makeTool("create_issue", "Create an issue");
    const namespaced = namespaceTool("linear", tool);

    expect(namespaced.name).toBe("linear__create_issue");
  });

  it("preserves description, inputSchema, and other fields", () => {
    const tool: Tool = {
      name: "run_query",
      description: "Run a DB query",
      inputSchema: {
        type: "object" as const,
        properties: { sql: { type: "string" } },
        required: ["sql"],
      },
    };
    const namespaced = namespaceTool("db", tool);

    expect(namespaced.description).toBe("Run a DB query");
    expect(namespaced.inputSchema).toEqual(tool.inputSchema);
  });
});

describe("parseNamespacedName", () => {
  it("splits on first separator", () => {
    const result = parseNamespacedName("linear__create_issue");

    expect(result).toEqual({ source: "linear", toolName: "create_issue" });
  });

  it("handles tool names containing the separator", () => {
    const result = parseNamespacedName("linear__my__tool");

    expect(result).toEqual({ source: "linear", toolName: "my__tool" });
  });

  it("returns undefined for names without separator", () => {
    expect(parseNamespacedName("no-separator")).toBeUndefined();
  });
});

describe("NAMESPACE_SEPARATOR", () => {
  it("is double underscore", () => {
    expect(NAMESPACE_SEPARATOR).toBe("__");
  });
});

// --- StdioServerTransport ---

describe("StdioServerTransport", () => {
  it("start() with PassThrough streams works without writing to stdout", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();

    const bridgeServer = new BridgeServer({
      stdin,
      stdout,
    });

    await bridgeServer.start();

    // Nothing should be written to stdout before a client sends a message
    const data = stdout.read();
    expect(data).toBeNull();

    stdin.end();
    await bridgeServer.close();
  });
});
