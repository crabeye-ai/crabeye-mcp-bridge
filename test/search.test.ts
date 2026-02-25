import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from "../src/server/tool-registry.js";
import { BridgeServer } from "../src/server/bridge-server.js";
import { ToolSearchService, SEARCH_TOOL_NAME, RUN_TOOL_NAME } from "../src/search/index.js";
import type { UpstreamClient } from "../src/upstream/types.js";

function makeTool(name: string, description?: string): Tool {
  return {
    name,
    description: description ?? `Tool ${name}`,
    inputSchema: { type: "object" as const },
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

// --- ToolSearchService unit tests ---

describe("ToolSearchService", () => {
  let registry: ToolRegistry;
  let service: ToolSearchService;

  beforeEach(() => {
    registry = new ToolRegistry();
    service = new ToolSearchService(registry);
  });

  describe("getVisibleTools", () => {
    it("returns only meta-tools initially", () => {
      const tools = service.getVisibleTools();
      expect(tools).toHaveLength(2);
      expect(tools.map((t) => t.name)).toEqual([SEARCH_TOOL_NAME, RUN_TOOL_NAME]);
    });
  });

  describe("text search", () => {
    beforeEach(() => {
      registry.setToolsForSource("linear", [
        makeTool("linear__create_issue", "Create a new Linear issue"),
        makeTool("linear__list_issues", "List all Linear issues"),
      ]);
      registry.setToolsForSource("github", [
        makeTool("github__create_pr", "Create a pull request on GitHub"),
        makeTool("github__list_repos", "List repositories"),
      ]);
    });

    it("matches by tool name", () => {
      const result = service.search({ queries: ["create_issue"] });
      expect(result.tools.some((r) => r.tool_name === "linear__create_issue")).toBe(true);
    });

    it("matches by description", () => {
      const result = service.search({ queries: ["pull request"] });
      expect(result.tools.some((r) => r.tool_name === "github__create_pr")).toBe(true);
    });

    it("name matches rank higher than description matches", () => {
      const result = service.search({ queries: ["create"] });
      const nameMatchIdx = result.tools.findIndex((r) => r.tool_name === "linear__create_issue");
      const descMatchIdx = result.tools.findIndex((r) => r.tool_name === "github__create_pr");

      expect(nameMatchIdx).not.toBe(-1);
      expect(descMatchIdx).not.toBe(-1);

      registry.setToolsForSource("test", [
        makeTool("test__create_widget", "A simple utility"),
        makeTool("test__run_job", "Create and execute a batch job"),
      ]);

      const result2 = service.search({ queries: ["create"] });
      const nameIdx = result2.tools.findIndex((r) => r.tool_name === "test__create_widget");
      const descIdx = result2.tools.findIndex((r) => r.tool_name === "test__run_job");

      expect(nameIdx).not.toBe(-1);
      if (descIdx !== -1) {
        expect(nameIdx).toBeLessThan(descIdx);
      }
    });

    it("multiple queries are OR-combined", () => {
      const result = service.search({ queries: ["create_issue", "list_repos"] });
      const names = result.tools.map((r) => r.tool_name);
      expect(names).toContain("linear__create_issue");
      expect(names).toContain("github__list_repos");
    });
  });

  describe("regex search", () => {
    beforeEach(() => {
      registry.setToolsForSource("linear", [
        makeTool("linear__create_issue", "Create a new issue"),
        makeTool("linear__list_issues", "List issues"),
      ]);
      registry.setToolsForSource("github", [
        makeTool("github__create_pr", "Create a pull request"),
      ]);
    });

    it("/regex/i query works", () => {
      const result = service.search({ queries: ["/CREATE/i"] });
      expect(result.total).toBe(2);
      const names = result.tools.map((r) => r.tool_name);
      expect(names).toContain("linear__create_issue");
      expect(names).toContain("github__create_pr");
    });

    it("regex matches against name, description, source", () => {
      const result = service.search({ queries: ["/^linear__/"] });
      expect(result.total).toBe(2);
      expect(result.tools.every((r) => r.tool_name.startsWith("linear__"))).toBe(true);
    });

    it("invalid regex falls back to text search", () => {
      const result = service.search({ queries: ["/[invalid/"] });
      expect(result).toBeDefined();
      expect(result.tools).toBeDefined();
    });
  });

  describe("provider search", () => {
    beforeEach(() => {
      registry.setToolsForSource("linear", [
        makeTool("linear__create_issue", "Create issue"),
        makeTool("linear__list_issues", "List issues"),
      ]);
      registry.setToolsForSource("github", [
        makeTool("github__create_pr", "Create PR"),
      ]);
      registry.setToolsForSource("figma", [
        makeTool("figma__export", "Export design"),
      ]);
    });

    it("exact provider name returns provider info without tool details", () => {
      const result = service.search({ providers: ["linear"] });
      expect(result.total).toBe(2);
      expect(result.tools).toEqual([]);
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].name).toBe("linear");
      expect(result.providers[0].tool_count).toBe(2);
    });

    it("substring provider match works", () => {
      const result = service.search({ providers: ["git"] });
      expect(result.total).toBe(1);
      expect(result.tools).toEqual([]);
      expect(result.providers[0].name).toBe("github");
    });

    it("regex provider search works", () => {
      const result = service.search({ providers: ["/^(linear|figma)$/"] });
      expect(result.total).toBe(3);
      const sources = new Set(result.providers.map((r) => r.name));
      expect(sources).toEqual(new Set(["linear", "figma"]));
    });

    it("multiple providers are OR-combined", () => {
      const result = service.search({ providers: ["linear", "figma"] });
      expect(result.total).toBe(3);
      const sources = new Set(result.providers.map((r) => r.name));
      expect(sources).toEqual(new Set(["linear", "figma"]));
    });

    it("queries + providers intersection", () => {
      const result = service.search({
        queries: ["create"],
        providers: ["linear"],
      });
      expect(result.tools.every((r) => r.source === "linear")).toBe(true);
      expect(result.tools.some((r) => r.tool_name === "linear__create_issue")).toBe(true);
      expect(result.tools.some((r) => r.tool_name === "github__create_pr")).toBe(false);
    });
  });

  describe("categories search", () => {
    beforeEach(() => {
      registry.setToolsForSource("linear", [
        makeTool("linear__create_issue", "Create issue"),
      ]);
      registry.setToolsForSource("github", [
        makeTool("github__create_pr", "Create PR"),
      ]);
      registry.setToolsForSource("figma", [
        makeTool("figma__export", "Export design"),
      ]);
    });

    it("categories works like providers", () => {
      const result = service.search({ categories: ["linear"] });
      expect(result.total).toBe(1);
      expect(result.tools).toEqual([]);
      expect(result.providers[0].name).toBe("linear");
    });

    it("multiple categories are OR-combined", () => {
      const result = service.search({ categories: ["linear", "github"] });
      expect(result.total).toBe(2);
      const sources = new Set(result.providers.map((r) => r.name));
      expect(sources).toEqual(new Set(["linear", "github"]));
    });

    it("categories and providers are merged", () => {
      const result = service.search({ providers: ["linear"], categories: ["figma"] });
      expect(result.total).toBe(2);
      const sources = new Set(result.providers.map((r) => r.name));
      expect(sources).toEqual(new Set(["linear", "figma"]));
    });

    it("queries + categories intersection", () => {
      const result = service.search({
        queries: ["create"],
        categories: ["github"],
      });
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].tool_name).toBe("github__create_pr");
    });

    it("categories accepts regex patterns", () => {
      const result = service.search({ categories: ["/^fig/"] });
      expect(result.total).toBe(1);
      expect(result.tools).toEqual([]);
      expect(result.providers[0].name).toBe("figma");
    });
  });

  describe("provider results in response", () => {
    beforeEach(() => {
      registry.setToolsForSource("linear", [
        makeTool("linear__create_issue", "Create issue"),
        makeTool("linear__list_issues", "List issues"),
      ]);
      registry.setToolsForSource("github", [
        makeTool("github__create_pr", "Create PR"),
      ]);
      registry.setToolsForSource("figma", [
        makeTool("figma__export", "Export design"),
      ]);
    });

    it("includes provider info for matched tools", () => {
      const result = service.search({ queries: ["create"] });
      expect(result.providers.length).toBeGreaterThan(0);

      const linearProvider = result.providers.find((p) => p.name === "linear");
      expect(linearProvider).toBeDefined();
      expect(linearProvider!.tool_count).toBe(2);
      expect(linearProvider!.tools).toContain("linear__create_issue");
    });

    it("provider results include total tool_count not just matched count", () => {
      const result = service.search({ queries: ["create"] });
      const linearProvider = result.providers.find((p) => p.name === "linear");
      // linear has 2 tools total, even though only 1 matched
      expect(linearProvider!.tool_count).toBe(2);
    });

    it("provider search returns provider info even for unmatched tools", () => {
      // Search for providers by name, but add a query that matches nothing
      const result = service.search({
        queries: ["nonexistent_xyz"],
        providers: ["figma"],
      });
      // No tools matched the intersection, but figma provider should still be in results
      const figmaProvider = result.providers.find((p) => p.name === "figma");
      expect(figmaProvider).toBeDefined();
      expect(figmaProvider!.tool_count).toBe(1);
      expect(figmaProvider!.tools).toEqual([]);
    });

    it("providers sorted by tool_count descending", () => {
      const result = service.search({ providers: ["linear", "github", "figma"] });
      expect(result.providers[0].name).toBe("linear");
      expect(result.providers[0].tool_count).toBe(2);
    });

    it("provider-only search includes provider info without tool names", () => {
      const result = service.search({ providers: ["linear"] });
      expect(result.providers).toHaveLength(1);
      expect(result.providers[0].name).toBe("linear");
      expect(result.providers[0].tool_count).toBe(2);
      expect(result.providers[0].tools).toEqual([]);
    });
  });

  describe("error handling", () => {
    it("returns empty when no criteria specified", () => {
      registry.setToolsForSource("a", [makeTool("a__tool")]);

      const result = service.search({});
      expect(result.total).toBe(0);
      expect(result.tools).toEqual([]);
      expect(result.providers).toEqual([]);
    });

    it("returns empty with all empty arrays", () => {
      registry.setToolsForSource("a", [makeTool("a__tool")]);

      const result = service.search({ queries: [], providers: [], categories: [] });
      expect(result.total).toBe(0);
    });
  });

  describe("pagination", () => {
    beforeEach(() => {
      const tools = Array.from({ length: 30 }, (_, i) =>
        makeTool(`src__tool_${String(i).padStart(2, "0")}`, `Tool number ${i}`),
      );
      registry.setToolsForSource("src", tools);
    });

    it("limit and offset pagination", () => {
      const page1 = service.search({ queries: ["Tool number"], limit: 5, offset: 0 });
      expect(page1.count).toBe(5);
      expect(page1.total).toBe(30);
      expect(page1.limit).toBe(5);
      expect(page1.offset).toBe(0);

      const page2 = service.search({ queries: ["Tool number"], limit: 5, offset: 5 });
      expect(page2.count).toBe(5);
      expect(page2.offset).toBe(5);

      const page1Names = page1.tools.map((r) => r.tool_name);
      const page2Names = page2.tools.map((r) => r.tool_name);
      expect(page1Names.filter((n) => page2Names.includes(n))).toHaveLength(0);
    });

    it("limit clamped to 50", () => {
      const result = service.search({ queries: ["Tool number"], limit: 100 });
      expect(result.limit).toBe(50);
      expect(result.count).toBeLessThanOrEqual(50);
    });

    it("default limit is 20", () => {
      const result = service.search({ queries: ["Tool number"] });
      expect(result.limit).toBe(20);
      expect(result.count).toBe(20);
    });

    it("only paged tools are enabled in getVisibleTools", () => {
      service.search({ queries: ["Tool number"], limit: 5, offset: 0 });
      const visible = service.getVisibleTools();
      // search_tools + run_tool + 5 paged tools
      expect(visible).toHaveLength(7);
    });

    it("auto_enabled only contains paged tools", () => {
      const result = service.search({ queries: ["Tool number"], limit: 5, offset: 0 });
      expect(result.auto_enabled).toHaveLength(5);
      expect(result.total).toBe(30);
    });

    it("paging to next page replaces enabled tools", () => {
      const page1 = service.search({ queries: ["Tool number"], limit: 5, offset: 0 });

      const page2 = service.search({ queries: ["Tool number"], limit: 5, offset: 5 });
      const page2Visible = service.getVisibleTools().map((t) => t.name);

      // Page 1 tools should no longer be visible
      for (const name of page1.auto_enabled) {
        expect(page2Visible).not.toContain(name);
      }
      // Page 2 tools should be visible
      for (const name of page2.auto_enabled) {
        expect(page2Visible).toContain(name);
      }
    });
  });

  describe("enable/replace", () => {
    beforeEach(() => {
      registry.setToolsForSource("linear", [
        makeTool("linear__create_issue", "Create issue"),
        makeTool("linear__list_issues", "List issues"),
      ]);
      registry.setToolsForSource("github", [
        makeTool("github__create_pr", "Create PR"),
      ]);
    });

    it("search results appear in getVisibleTools", () => {
      service.search({ queries: ["create"] });
      const tools = service.getVisibleTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain(SEARCH_TOOL_NAME);
      expect(names).toContain("linear__create_issue");
      expect(names).toContain("github__create_pr");
    });

    it("new search replaces previously enabled tools", () => {
      service.search({ queries: ["create"] });
      let names = service.getVisibleTools().map((t) => t.name);
      expect(names).toContain("linear__create_issue");
      expect(names).toContain("github__create_pr");

      service.search({ queries: ["create_pr"] });
      names = service.getVisibleTools().map((t) => t.name);
      expect(names).toContain("github__create_pr");
      expect(names).not.toContain("linear__create_issue");
      expect(names).not.toContain("linear__list_issues");
    });

    it("onVisibleToolsChanged fires when search enables tools", () => {
      const callback = vi.fn();
      service.onVisibleToolsChanged(callback);

      service.search({ queries: ["create"] });
      expect(callback).toHaveBeenCalledOnce();
    });

    it("onVisibleToolsChanged does not fire when results are identical", () => {
      const callback = vi.fn();

      service.search({ queries: ["pull request"] });
      service.onVisibleToolsChanged(callback);

      service.search({ queries: ["pull request"] });
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("registry changes", () => {
    it("index rebuilt when registry changes", () => {
      registry.setToolsForSource("a", [makeTool("a__original", "Original tool")]);

      let result = service.search({ queries: ["original"] });
      expect(result.total).toBe(1);

      registry.setToolsForSource("a", [makeTool("a__replacement", "Replacement tool")]);

      result = service.search({ queries: ["replacement"] });
      expect(result.total).toBe(1);
      expect(result.tools[0].tool_name).toBe("a__replacement");

      result = service.search({ queries: ["original"] });
      expect(result.total).toBe(0);
    });

    it("enabled tools pruned when removed from registry", () => {
      registry.setToolsForSource("a", [makeTool("a__tool1", "Alpha tool"), makeTool("a__tool2", "Alpha tool")]);
      service.search({ queries: ["Alpha tool"] });

      let visible = service.getVisibleTools().map((t) => t.name);
      expect(visible).toContain("a__tool1");
      expect(visible).toContain("a__tool2");

      registry.setToolsForSource("a", [makeTool("a__tool1", "Alpha tool")]);

      visible = service.getVisibleTools().map((t) => t.name);
      expect(visible).toContain("a__tool1");
      expect(visible).not.toContain("a__tool2");
    });

    it("visibleToolsChanged fires on prune", () => {
      registry.setToolsForSource("a", [makeTool("a__tool1", "Alpha tool"), makeTool("a__tool2", "Alpha tool")]);
      service.search({ queries: ["Alpha tool"] });

      const callback = vi.fn();
      service.onVisibleToolsChanged(callback);

      registry.setToolsForSource("a", [makeTool("a__tool1")]);
      expect(callback).toHaveBeenCalled();
    });

    it("new upstream tools become searchable", () => {
      let result = service.search({ queries: ["new_tool"] });
      expect(result.total).toBe(0);

      registry.setToolsForSource("new", [makeTool("new__new_tool", "A brand new tool")]);

      result = service.search({ queries: ["new_tool"] });
      expect(result.total).toBe(1);
    });
  });

  describe("dispose", () => {
    it("unsubscribes from registry", () => {
      const callback = vi.fn();
      service.onVisibleToolsChanged(callback);

      registry.setToolsForSource("a", [makeTool("a__t1", "Alpha tool")]);
      service.search({ queries: ["Alpha tool"] });
      callback.mockClear();

      service.dispose();

      registry.setToolsForSource("a", []);
      expect(callback).not.toHaveBeenCalled();
    });
  });
});

// --- BridgeServer integration tests ---

describe("BridgeServer with ToolSearchService", () => {
  async function createSearchTestPair(tools?: { source: string; tools: Tool[] }[]) {
    const toolRegistry = new ToolRegistry();
    for (const { source, tools: t } of tools ?? []) {
      toolRegistry.setToolsForSource(source, t);
    }

    const toolSearchService = new ToolSearchService(toolRegistry);

    const linearClient = makeMockUpstreamClient("linear", {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "upstream result" }],
      } satisfies CallToolResult),
    });

    const server = new BridgeServer({
      toolRegistry,
      toolSearchService,
      getUpstreamClient: (name) => (name === "linear" ? linearClient : undefined),
    });

    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    return {
      server,
      client,
      toolRegistry,
      toolSearchService,
      linearClient,
      async cleanup() {
        await client.close();
        await server.close();
      },
    };
  }

  it("tools/list returns only meta-tools when no search done", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__create_issue", "Create issue")] },
    ]);

    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    const names = result.tools.map((t) => t.name);
    expect(names).toContain(SEARCH_TOOL_NAME);
    expect(names).toContain(RUN_TOOL_NAME);

    await cleanup();
  });

  it("search_tools call returns tools and providers", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__create_issue", "Create issue")] },
    ]);

    const result = await client.callTool({
      name: SEARCH_TOOL_NAME,
      arguments: { queries: ["create"] },
    });

    expect(result.content).toHaveLength(1);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.total).toBeGreaterThan(0);
    expect(parsed.tools[0].tool_name).toBe("linear__create_issue");
    expect(parsed.providers).toBeDefined();
    expect(parsed.providers[0].name).toBe("linear");

    await cleanup();
  });

  it("search by provider returns provider info without tool details", async () => {
    const { client, cleanup } = await createSearchTestPair([
      {
        source: "linear",
        tools: [
          makeTool("linear__create_issue", "Create issue"),
          makeTool("linear__list_issues", "List issues"),
        ],
      },
      { source: "github", tools: [makeTool("github__create_pr", "Create PR")] },
    ]);

    const result = await client.callTool({
      name: SEARCH_TOOL_NAME,
      arguments: { providers: ["linear"] },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsed.total).toBe(2);
    expect(parsed.tools).toEqual([]);
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0].name).toBe("linear");
    expect(parsed.providers[0].tool_count).toBe(2);

    await cleanup();
  });

  it("search by categories returns provider info without tool details", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__create_issue", "Create issue")] },
      { source: "github", tools: [makeTool("github__create_pr", "Create PR")] },
    ]);

    const result = await client.callTool({
      name: SEARCH_TOOL_NAME,
      arguments: { categories: ["github"] },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsed.total).toBe(1);
    expect(parsed.tools).toEqual([]);
    expect(parsed.providers[0].name).toBe("github");

    await cleanup();
  });

  it("auto-enabled tools appear in subsequent tools/list", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__create_issue", "Create issue")] },
    ]);

    let list = await client.listTools();
    expect(list.tools).toHaveLength(2);

    await client.callTool({
      name: SEARCH_TOOL_NAME,
      arguments: { queries: ["create"] },
    });

    list = await client.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain(SEARCH_TOOL_NAME);
    expect(names).toContain("linear__create_issue");

    await cleanup();
  });

  it("tools/list_changed notification sent after search", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__create_issue", "Create issue")] },
    ]);

    const notificationReceived = new Promise<void>((resolve) => {
      client.setNotificationHandler(
        ToolListChangedNotificationSchema,
        () => { resolve(); },
      );
    });

    await client.callTool({
      name: SEARCH_TOOL_NAME,
      arguments: { queries: ["create"] },
    });

    await expect(
      Promise.race([
        notificationReceived,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 2000),
        ),
      ]),
    ).resolves.toBeUndefined();

    await cleanup();
  });

  it("namespaced tool calls still route to upstreams", async () => {
    const { client, linearClient, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__create_issue", "Create issue")] },
    ]);

    await client.callTool({
      name: SEARCH_TOOL_NAME,
      arguments: { queries: ["create"] },
    });

    const result = await client.callTool({
      name: "linear__create_issue",
      arguments: { title: "Test" },
    });

    expect(result.content).toEqual([{ type: "text", text: "upstream result" }]);
    expect(linearClient.callTool).toHaveBeenCalledWith({
      name: "create_issue",
      arguments: { title: "Test" },
    });

    await cleanup();
  });

  it("search_tools with no args returns error", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__tool")] },
    ]);

    const result = await client.callTool({
      name: SEARCH_TOOL_NAME,
      arguments: {},
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Error");
    expect(result.isError).toBe(true);

    await cleanup();
  });

  // --- run_tool ---

  it("run_tool calls upstream tool without search", async () => {
    const { client, linearClient, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__create_issue", "Create issue")] },
    ]);

    const result = await client.callTool({
      name: RUN_TOOL_NAME,
      arguments: { name: "linear__create_issue", arguments: { title: "Bug" } },
    });

    expect(result.content).toEqual([{ type: "text", text: "upstream result" }]);
    expect(linearClient.callTool).toHaveBeenCalledWith({
      name: "create_issue",
      arguments: { title: "Bug" },
    });

    await cleanup();
  });

  it("run_tool works without arguments field", async () => {
    const { client, linearClient, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__list_issues", "List issues")] },
    ]);

    const result = await client.callTool({
      name: RUN_TOOL_NAME,
      arguments: { name: "linear__list_issues" },
    });

    expect(result.content).toEqual([{ type: "text", text: "upstream result" }]);
    expect(linearClient.callTool).toHaveBeenCalledWith({
      name: "list_issues",
      arguments: undefined,
    });

    await cleanup();
  });

  it("run_tool with missing name returns error", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__tool")] },
    ]);

    const result = await client.callTool({
      name: RUN_TOOL_NAME,
      arguments: {},
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Error");
    expect(result.isError).toBe(true);

    await cleanup();
  });

  it("run_tool with invalid namespace throws error", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__tool")] },
    ]);

    await expect(
      client.callTool({
        name: RUN_TOOL_NAME,
        arguments: { name: "no-namespace" },
      }),
    ).rejects.toThrow(/missing namespace/);

    await cleanup();
  });

  it("run_tool with unknown upstream throws error", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__tool")] },
    ]);

    await expect(
      client.callTool({
        name: RUN_TOOL_NAME,
        arguments: { name: "unknown__tool" },
      }),
    ).rejects.toThrow(/Upstream server not found/);

    await cleanup();
  });

  it("run_tool is always visible in tools/list", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__tool")] },
    ]);

    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toContain(RUN_TOOL_NAME);

    await cleanup();
  });
});
