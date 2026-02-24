import { describe, it, expect, beforeEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from "../src/server/tool-registry.js";
import { BridgeServer } from "../src/server/bridge-server.js";
import type { BridgeServerOptions } from "../src/server/bridge-server.js";
import type { UpstreamClient } from "../src/upstream/types.js";
import {
  NAMESPACE_SEPARATOR,
  namespaceTool,
  parseNamespacedName,
} from "../src/server/tool-namespacing.js";

function makeTool(name: string, description?: string): Tool {
  return {
    name,
    description: description ?? `Tool ${name}`,
    inputSchema: { type: "object" as const },
  };
}

async function createTestPair(options?: {
  registry?: ToolRegistry;
  getUpstreamClient?: BridgeServerOptions["getUpstreamClient"];
}) {
  const toolRegistry = options?.registry ?? new ToolRegistry();
  const server = new BridgeServer({
    toolRegistry,
    getUpstreamClient: options?.getUpstreamClient,
  });

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    server,
    client,
    toolRegistry,
    async cleanup() {
      await client.close();
      await server.close();
    },
  };
}

function makeMockUpstreamClient(
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
    onStatusChange: vi.fn().mockReturnValue(() => {}),
    onToolsChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

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
    expect(serverInfo!.name).toBe("kokuai-bridge");
    expect(serverInfo!.version).toBe("0.1.0");

    await cleanup();
  });

  it("advertises tools capability with listChanged", async () => {
    const { client, cleanup } = await createTestPair();

    const capabilities = client.getServerCapabilities();
    expect(capabilities).toBeDefined();
    expect(capabilities!.tools).toBeDefined();
    expect(capabilities!.tools!.listChanged).toBe(true);

    await cleanup();
  });
});

// --- tools/list ---

describe("tools/list", () => {
  it("returns empty list initially", async () => {
    const { client, cleanup } = await createTestPair();

    const result = await client.listTools();
    expect(result.tools).toEqual([]);

    await cleanup();
  });

  it("returns tools after registry populated", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("server-a", [
      makeTool("read-file", "Read a file"),
      makeTool("write-file", "Write a file"),
    ]);

    const { client, cleanup } = await createTestPair({ registry });

    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.name).sort()).toEqual(["read-file", "write-file"]);

    await cleanup();
  });

  it("returns tools from multiple sources", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("server-a", [makeTool("tool-a")]);
    registry.setToolsForSource("server-b", [makeTool("tool-b")]);

    const { client, cleanup } = await createTestPair({ registry });

    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.name).sort()).toEqual(["tool-a", "tool-b"]);

    await cleanup();
  });
});

// --- tools/call ---

describe("tools/call", () => {
  it("throws error for unknown tool", async () => {
    const { client, cleanup } = await createTestPair();

    await expect(
      client.callTool({ name: "nonexistent", arguments: {} }),
    ).rejects.toThrow(/Unknown tool/);

    await cleanup();
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

    const result = await client.callTool({
      name: "linear__create_issue",
      arguments: { title: "Bug" },
    });

    expect(result.content).toEqual([{ type: "text", text: "issue created" }]);
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "create_issue",
      arguments: { title: "Bug" },
    });

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

    const result = await client.callTool({
      name: "github__create_issue",
      arguments: {},
    });

    expect(result.content).toEqual([{ type: "text", text: "github issue" }]);
    expect(githubClient.callTool).toHaveBeenCalledWith({ name: "create_issue", arguments: {} });
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
      client.callTool({ name: "gone__my-tool", arguments: {} }),
    ).rejects.toThrow(/Upstream server not found: gone/);

    await cleanup();
  });

  it("throws error when upstream is disconnected", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__my-tool")]);

    const mockClient = makeMockUpstreamClient("srv", { status: "disconnected" });

    const { client, cleanup } = await createTestPair({
      registry,
      getUpstreamClient: () => mockClient,
    });

    await expect(
      client.callTool({ name: "srv__my-tool", arguments: {} }),
    ).rejects.toThrow(/not connected/);

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
      client.callTool({ name: "flaky__broken", arguments: {} }),
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
      client.callTool({ name: "no-namespace", arguments: {} }),
    ).rejects.toThrow(/missing namespace/);

    await cleanup();
  });

  it("throws error when no upstream client resolver is configured", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("srv", [makeTool("srv__tool")]);

    const { client, cleanup } = await createTestPair({ registry });

    await expect(
      client.callTool({ name: "srv__tool", arguments: {} }),
    ).rejects.toThrow(/No upstream client resolver/);

    await cleanup();
  });
});

// --- Notifications ---

describe("notifications", () => {
  it("client receives tools/list_changed when registry changes", async () => {
    const registry = new ToolRegistry();
    const { client, cleanup } = await createTestPair({ registry });

    const notificationReceived = new Promise<void>((resolve) => {
      client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        () => {
          resolve();
        },
      );
    });

    // Trigger a change after the handler is set
    registry.setToolsForSource("server-a", [makeTool("new-tool")]);

    await expect(
      Promise.race([
        notificationReceived,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout waiting for notification")), 2000),
        ),
      ]),
    ).resolves.toBeUndefined();

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
