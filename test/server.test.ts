import { describe, it, expect, beforeEach, vi } from "vitest";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from "../src/server/tool-registry.js";
import { BridgeServer } from "../src/server/bridge-server.js";

function makeTool(name: string, description?: string): Tool {
  return {
    name,
    description: description ?? `Tool ${name}`,
    inputSchema: { type: "object" as const },
  };
}

async function createTestPair(registry?: ToolRegistry) {
  const toolRegistry = registry ?? new ToolRegistry();
  const server = new BridgeServer({ toolRegistry });

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

    const { client, cleanup } = await createTestPair(registry);

    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t) => t.name).sort()).toEqual(["read-file", "write-file"]);

    await cleanup();
  });

  it("returns tools from multiple sources", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("server-a", [makeTool("tool-a")]);
    registry.setToolsForSource("server-b", [makeTool("tool-b")]);

    const { client, cleanup } = await createTestPair(registry);

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

  it("throws error for known tool (routing not implemented)", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("server-a", [makeTool("my-tool")]);

    const { client, cleanup } = await createTestPair(registry);

    await expect(
      client.callTool({ name: "my-tool", arguments: {} }),
    ).rejects.toThrow(/routing not implemented/);

    await cleanup();
  });
});

// --- Notifications ---

describe("notifications", () => {
  it("client receives tools/list_changed when registry changes", async () => {
    const registry = new ToolRegistry();
    const { client, cleanup } = await createTestPair(registry);

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
