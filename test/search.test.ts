import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from "../src/server/tool-registry.js";
import { BridgeServer } from "../src/server/bridge-server.js";
import { ToolSearchService, SEARCH_TOOL_NAME, RUN_TOOL_NAME } from "../src/search/index.js";
import type { QueryResult } from "../src/search/index.js";
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

/** Flatten all tools from a provider-grouped QueryResult */
function allTools(qr: QueryResult) {
  return qr.providers.flatMap((p) => p.tools);
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
      const result = service.search({ queries: [{ tool: "create_issue" }] });
      expect(allTools(result.results[0]).some((r) => r.tool_name === "linear__create_issue")).toBe(true);
    });

    it("matches by description", () => {
      const result = service.search({ queries: [{ tool: "pull request" }] });
      expect(allTools(result.results[0]).some((r) => r.tool_name === "github__create_pr")).toBe(true);
    });

    it("name matches rank higher than description matches", () => {
      const result = service.search({ queries: [{ tool: "create" }] });
      const tools = allTools(result.results[0]);
      const nameMatchIdx = tools.findIndex((r) => r.tool_name === "linear__create_issue");
      const descMatchIdx = tools.findIndex((r) => r.tool_name === "github__create_pr");

      expect(nameMatchIdx).not.toBe(-1);
      expect(descMatchIdx).not.toBe(-1);

      registry.setToolsForSource("test", [
        makeTool("test__create_widget", "A simple utility"),
        makeTool("test__run_job", "Create and execute a batch job"),
      ]);

      const result2 = service.search({ queries: [{ tool: "create" }] });
      const tools2 = allTools(result2.results[0]);
      const nameIdx = tools2.findIndex((r) => r.tool_name === "test__create_widget");
      const descIdx = tools2.findIndex((r) => r.tool_name === "test__run_job");

      expect(nameIdx).not.toBe(-1);
      if (descIdx !== -1) {
        expect(nameIdx).toBeLessThan(descIdx);
      }
    });

    it("multiple query objects produce separate results", () => {
      const result = service.search({
        queries: [{ tool: "create_issue" }, { tool: "list_repos" }],
      });
      expect(result.results).toHaveLength(2);
      expect(allTools(result.results[0]).some((r) => r.tool_name === "linear__create_issue")).toBe(true);
      expect(allTools(result.results[1]).some((r) => r.tool_name === "github__list_repos")).toBe(true);
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
      const result = service.search({ queries: [{ tool: "/CREATE/i" }] });
      expect(result.results[0].total).toBe(2);
      const names = allTools(result.results[0]).map((r) => r.tool_name);
      expect(names).toContain("linear__create_issue");
      expect(names).toContain("github__create_pr");
    });

    it("regex matches against name, description, source", () => {
      const result = service.search({ queries: [{ tool: "/^linear__/" }] });
      expect(result.results[0].total).toBe(2);
      expect(allTools(result.results[0]).every((r) => r.tool_name.startsWith("linear__"))).toBe(true);
    });

    it("invalid regex falls back to text search", () => {
      const result = service.search({ queries: [{ tool: "/[invalid/" }] });
      expect(result).toBeDefined();
      expect(allTools(result.results[0])).toBeDefined();
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

    it("exact provider name returns all tools from that provider (with expand_tools)", () => {
      const result = service.search({ queries: [{ provider: "linear", expand_tools: true }] });
      expect(result.results[0].total).toBe(2);
      expect(allTools(result.results[0])).toHaveLength(2);
      expect(allTools(result.results[0]).every((r) => r.source === "linear")).toBe(true);
    });

    it("provider-only returns summary (no tools) by default", () => {
      const result = service.search({ queries: [{ provider: "linear" }] });
      expect(result.results[0].total).toBe(2);
      expect(result.results[0].count).toBe(0);
      expect(result.results[0].remaining).toBe(0);
      expect(result.results[0].providers).toHaveLength(1);
      expect(result.results[0].providers[0].name).toBe("linear");
      expect(result.results[0].providers[0].tool_count).toBe(2);
      expect(result.results[0].providers[0].tools).toHaveLength(0);
    });

    it("prefix provider match works", () => {
      const result = service.search({ queries: [{ provider: "git", expand_tools: true }] });
      expect(result.results[0].total).toBe(1);
      expect(allTools(result.results[0])[0].source).toBe("github");
    });

    it("substring (non-prefix) does NOT match", () => {
      const result = service.search({ queries: [{ provider: "hub" }] });
      expect(result.results[0].total).toBe(0);
      expect(result.results[0].providers).toHaveLength(0);
    });

    it("regex provider search works", () => {
      const result = service.search({ queries: [{ provider: "/^(linear|figma)$/", expand_tools: true }] });
      expect(result.results[0].total).toBe(3);
      const sources = new Set(allTools(result.results[0]).map((r) => r.source));
      expect(sources).toEqual(new Set(["linear", "figma"]));
    });

    it("tool + provider intersection", () => {
      const result = service.search({
        queries: [{ tool: "create", provider: "linear" }],
      });
      const tools = allTools(result.results[0]);
      expect(tools.every((r) => r.source === "linear")).toBe(true);
      expect(tools.some((r) => r.tool_name === "linear__create_issue")).toBe(true);
      expect(tools.some((r) => r.tool_name === "github__create_pr")).toBe(false);
    });
  });

  describe("category search", () => {
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
      registry.setCategoryForSource("linear", "project management");
      registry.setCategoryForSource("github", "development");
      registry.setCategoryForSource("figma", "design");
      // Rebuild index so categories are picked up
      service = new ToolSearchService(registry);
    });

    it("category prefix match works", () => {
      const result = service.search({ queries: [{ category: "project", expand_tools: true }] });
      expect(result.results[0].total).toBe(1);
      expect(allTools(result.results[0])[0].tool_name).toBe("linear__create_issue");
    });

    it("category regex works", () => {
      const result = service.search({ queries: [{ category: "/^design$/", expand_tools: true }] });
      expect(result.results[0].total).toBe(1);
      expect(allTools(result.results[0])[0].tool_name).toBe("figma__export");
    });

    it("category substring (non-prefix) does NOT match", () => {
      const result = service.search({ queries: [{ category: "management" }] });
      expect(result.results[0].total).toBe(0);
      expect(result.results[0].providers).toHaveLength(0);
    });

    it("tool + category intersection", () => {
      const result = service.search({
        queries: [{ tool: "create", category: "development" }],
      });
      const tools = allTools(result.results[0]);
      expect(tools).toHaveLength(1);
      expect(tools[0].tool_name).toBe("github__create_pr");
    });

    it("provider + category intersection", () => {
      const result = service.search({
        queries: [{ provider: "linear", category: "project", expand_tools: true }],
      });
      expect(result.results[0].total).toBe(1);
      expect(allTools(result.results[0])[0].tool_name).toBe("linear__create_issue");
    });

    it("provider + category mismatch returns empty", () => {
      const result = service.search({
        queries: [{ provider: "linear", category: "design" }],
      });
      expect(result.results[0].total).toBe(0);
      expect(result.results[0].providers).toHaveLength(0);
    });
  });

  describe("cross-query deduplication", () => {
    beforeEach(() => {
      registry.setToolsForSource("linear", [
        makeTool("linear__create_issue", "Create a new issue"),
        makeTool("linear__list_issues", "List issues"),
      ]);
      registry.setToolsForSource("github", [
        makeTool("github__create_pr", "Create a pull request"),
      ]);
    });

    it("first query wins — duplicate tools removed from later queries", () => {
      const result = service.search({
        queries: [
          { tool: "create" },
          { provider: "linear", expand_tools: true },
        ],
      });
      // First query gets create_issue and create_pr
      const firstNames = allTools(result.results[0]).map((r) => r.tool_name);
      expect(firstNames).toContain("linear__create_issue");
      expect(firstNames).toContain("github__create_pr");

      // Second query (all linear tools) should only get list_issues since create_issue already seen
      const secondNames = allTools(result.results[1]).map((r) => r.tool_name);
      expect(secondNames).toContain("linear__list_issues");
      expect(secondNames).not.toContain("linear__create_issue");
    });
  });

  describe("per-query pagination", () => {
    beforeEach(() => {
      const toolsA = Array.from({ length: 10 }, (_, i) =>
        makeTool(`alpha__tool_${String(i).padStart(2, "0")}`, `Alpha tool ${i}`),
      );
      const toolsB = Array.from({ length: 10 }, (_, i) =>
        makeTool(`beta__tool_${String(i).padStart(2, "0")}`, `Beta tool ${i}`),
      );
      registry.setToolsForSource("alpha", toolsA);
      registry.setToolsForSource("beta", toolsB);
    });

    it("each query has its own limit and offset", () => {
      const result = service.search({
        queries: [
          { provider: "alpha", expand_tools: true, limit: 3 },
          { provider: "beta", expand_tools: true, limit: 5 },
        ],
      });
      expect(result.results[0].count).toBe(3);
      expect(result.results[0].limit).toBe(3);

      expect(result.results[1].count).toBe(5);
      expect(result.results[1].limit).toBe(5);
    });

    it("offset works per query", () => {
      const result = service.search({
        queries: [{ provider: "alpha", expand_tools: true, limit: 5, offset: 5 }],
      });
      expect(result.results[0].offset).toBe(5);
      expect(result.results[0].count).toBe(5);
    });

    it("limit clamped to 50 per query", () => {
      const result = service.search({
        queries: [{ provider: "alpha", expand_tools: true, limit: 100 }],
      });
      expect(result.results[0].limit).toBe(50);
    });

    it("default limit is 10", () => {
      const result = service.search({
        queries: [{ provider: "alpha", expand_tools: true }],
      });
      expect(result.results[0].limit).toBe(10);
      expect(result.results[0].count).toBe(10);
    });
  });

  describe("auto-enable cap at 50", () => {
    it("total enabled tools capped at MAX_LIMIT across queries", () => {
      const tools = Array.from({ length: 60 }, (_, i) =>
        makeTool(`src__tool_${String(i).padStart(2, "0")}`, `Tool number ${i}`),
      );
      registry.setToolsForSource("src", tools);

      service.search({
        queries: [
          { tool: "Tool number", limit: 40 },
          { tool: "Tool number", limit: 40 },
        ],
      });

      const visible = service.getVisibleTools();
      // 2 meta-tools + at most 50 enabled tools
      expect(visible.length).toBeLessThanOrEqual(52);
    });
  });

  describe("error handling", () => {
    it("returns empty results when queries array is empty", () => {
      registry.setToolsForSource("a", [makeTool("a__tool")]);

      const result = service.search({ queries: [] });
      expect(result.results).toEqual([]);
    });

    it("query with no filters returns empty result for that slot", () => {
      registry.setToolsForSource("a", [makeTool("a__tool", "A tool")]);

      const result = service.search({ queries: [{} as any] });
      expect(result.results).toHaveLength(1);
      expect(result.results[0].total).toBe(0);
      expect(result.results[0].providers).toEqual([]);
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
      const page1 = service.search({ queries: [{ tool: "Tool number", limit: 5, offset: 0 }] });
      expect(page1.results[0].count).toBe(5);
      expect(page1.results[0].total).toBe(30);
      expect(page1.results[0].remaining).toBe(25);
      expect(page1.results[0].limit).toBe(5);
      expect(page1.results[0].offset).toBe(0);

      const page2 = service.search({ queries: [{ tool: "Tool number", limit: 5, offset: 5 }] });
      expect(page2.results[0].count).toBe(5);
      expect(page2.results[0].remaining).toBe(20);
      expect(page2.results[0].offset).toBe(5);

      const page1Names = allTools(page1.results[0]).map((r) => r.tool_name);
      const page2Names = allTools(page2.results[0]).map((r) => r.tool_name);
      expect(page1Names.filter((n) => page2Names.includes(n))).toHaveLength(0);
    });

    it("remaining is 0 when all results fit on one page", () => {
      const result = service.search({ queries: [{ tool: "Tool number", limit: 50 }] });
      expect(result.results[0].remaining).toBe(0);
      expect(result.results[0].count).toBe(30);
      expect(result.results[0].total).toBe(30);
    });

    it("limit clamped to 50", () => {
      const result = service.search({ queries: [{ tool: "Tool number", limit: 100 }] });
      expect(result.results[0].limit).toBe(50);
      expect(result.results[0].count).toBeLessThanOrEqual(50);
    });

    it("default limit is 10", () => {
      const result = service.search({ queries: [{ tool: "Tool number" }] });
      expect(result.results[0].limit).toBe(10);
      expect(result.results[0].count).toBe(10);
    });

    it("only paged tools are enabled in getVisibleTools", () => {
      service.search({ queries: [{ tool: "Tool number", limit: 5, offset: 0 }] });
      const visible = service.getVisibleTools();
      // search_tools + run_tool + 5 paged tools
      expect(visible).toHaveLength(7);
    });

    it("paging to next page replaces enabled tools", () => {
      service.search({ queries: [{ tool: "Tool number", limit: 5, offset: 0 }] });
      const page1Visible = service.getVisibleTools().map((t) => t.name).filter((n) => n !== SEARCH_TOOL_NAME && n !== RUN_TOOL_NAME);

      service.search({ queries: [{ tool: "Tool number", limit: 5, offset: 5 }] });
      const page2Visible = service.getVisibleTools().map((t) => t.name);

      // Page 1 tools should no longer be visible
      for (const name of page1Visible) {
        expect(page2Visible).not.toContain(name);
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
      service.search({ queries: [{ tool: "create" }] });
      const tools = service.getVisibleTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain(SEARCH_TOOL_NAME);
      expect(names).toContain("linear__create_issue");
      expect(names).toContain("github__create_pr");
    });

    it("new search replaces previously enabled tools", () => {
      service.search({ queries: [{ tool: "create" }] });
      let names = service.getVisibleTools().map((t) => t.name);
      expect(names).toContain("linear__create_issue");
      expect(names).toContain("github__create_pr");

      service.search({ queries: [{ tool: "create_pr" }] });
      names = service.getVisibleTools().map((t) => t.name);
      expect(names).toContain("github__create_pr");
      expect(names).not.toContain("linear__create_issue");
      expect(names).not.toContain("linear__list_issues");
    });

    it("onVisibleToolsChanged fires when search enables tools", () => {
      const callback = vi.fn();
      service.onVisibleToolsChanged(callback);

      service.search({ queries: [{ tool: "create" }] });
      expect(callback).toHaveBeenCalledOnce();
    });

    it("onVisibleToolsChanged does not fire when results are identical", () => {
      const callback = vi.fn();

      service.search({ queries: [{ tool: "pull request" }] });
      service.onVisibleToolsChanged(callback);

      service.search({ queries: [{ tool: "pull request" }] });
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("registry changes", () => {
    it("index rebuilt when registry changes", () => {
      registry.setToolsForSource("a", [makeTool("a__original", "Original tool")]);

      let result = service.search({ queries: [{ tool: "original" }] });
      expect(result.results[0].total).toBe(1);

      registry.setToolsForSource("a", [makeTool("a__replacement", "Replacement tool")]);

      result = service.search({ queries: [{ tool: "replacement" }] });
      expect(result.results[0].total).toBe(1);
      expect(allTools(result.results[0])[0].tool_name).toBe("a__replacement");

      result = service.search({ queries: [{ tool: "original" }] });
      expect(result.results[0].total).toBe(0);
    });

    it("enabled tools pruned when removed from registry", () => {
      registry.setToolsForSource("a", [makeTool("a__tool1", "Alpha tool"), makeTool("a__tool2", "Alpha tool")]);
      service.search({ queries: [{ tool: "Alpha tool" }] });

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
      service.search({ queries: [{ tool: "Alpha tool" }] });

      const callback = vi.fn();
      service.onVisibleToolsChanged(callback);

      registry.setToolsForSource("a", [makeTool("a__tool1")]);
      expect(callback).toHaveBeenCalled();
    });

    it("new upstream tools become searchable", () => {
      let result = service.search({ queries: [{ tool: "new_tool" }] });
      expect(result.results[0].total).toBe(0);

      registry.setToolsForSource("new", [makeTool("new__new_tool", "A brand new tool")]);

      result = service.search({ queries: [{ tool: "new_tool" }] });
      expect(result.results[0].total).toBe(1);
    });
  });

  describe("dispose", () => {
    it("unsubscribes from registry", () => {
      const callback = vi.fn();
      service.onVisibleToolsChanged(callback);

      registry.setToolsForSource("a", [makeTool("a__t1", "Alpha tool")]);
      service.search({ queries: [{ tool: "Alpha tool" }] });
      callback.mockClear();

      service.dispose();

      registry.setToolsForSource("a", []);
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe("provider-grouped response", () => {
    beforeEach(() => {
      registry.setToolsForSource("linear", [
        makeTool("linear__create_issue", "Create issue"),
        makeTool("linear__list_issues", "List issues"),
      ]);
      registry.setToolsForSource("github", [
        makeTool("github__create_pr", "Create PR"),
      ]);
      registry.setCategoryForSource("linear", "project management");
      service = new ToolSearchService(registry);
    });

    it("summaries include name, category, tool_count, and empty tools", () => {
      const result = service.search({ queries: [{ provider: "linear" }] });
      const qr = result.results[0];
      expect(qr.providers).toHaveLength(1);
      expect(qr.providers[0].name).toBe("linear");
      expect(qr.providers[0].category).toBe("project management");
      expect(qr.providers[0].tool_count).toBe(2);
      expect(qr.providers[0].tools).toEqual([]);
    });

    it("tool filter groups results by provider", () => {
      const result = service.search({ queries: [{ tool: "create" }] });
      const qr = result.results[0];
      // Should have two providers (linear and github both have "create" tools)
      expect(qr.providers.length).toBeGreaterThanOrEqual(2);
      const providerNames = qr.providers.map((p) => p.name);
      expect(providerNames).toContain("linear");
      expect(providerNames).toContain("github");
      // Each provider's tools[] should be non-empty
      for (const p of qr.providers) {
        expect(p.tools.length).toBeGreaterThan(0);
      }
    });

    it("tool_count reflects total tools from provider, not just matches", () => {
      const result = service.search({ queries: [{ tool: "create", provider: "linear" }] });
      const qr = result.results[0];
      expect(qr.providers).toHaveLength(1);
      // Only create_issue matches, but tool_count shows all linear tools
      expect(allTools(qr)).toHaveLength(1);
      expect(qr.providers[0].tool_count).toBe(2);
    });

    it("provider without category omits category field", () => {
      const result = service.search({ queries: [{ provider: "github" }] });
      const qr = result.results[0];
      expect(qr.providers).toHaveLength(1);
      expect(qr.providers[0].name).toBe("github");
      expect(qr.providers[0].category).toBeUndefined();
    });
  });

  describe("expand_tools", () => {
    beforeEach(() => {
      registry.setToolsForSource("linear", [
        makeTool("linear__create_issue", "Create issue"),
        makeTool("linear__list_issues", "List issues"),
      ]);
      registry.setToolsForSource("github", [
        makeTool("github__create_pr", "Create PR"),
      ]);
    });

    it("true returns all tools from matched providers", () => {
      const result = service.search({ queries: [{ provider: "linear", expand_tools: true }] });
      const tools = allTools(result.results[0]);
      expect(tools).toHaveLength(2);
      expect(tools.every((t) => t.source === "linear")).toBe(true);
    });

    it("with tool filter, tool filter takes precedence", () => {
      const result = service.search({
        queries: [{ tool: "create", provider: "linear", expand_tools: true }],
      });
      const tools = allTools(result.results[0]);
      // Tool filter "create" takes precedence — only create_issue matches
      expect(tools).toHaveLength(1);
      expect(tools[0].tool_name).toBe("linear__create_issue");
    });

    it("false is the default", () => {
      const result = service.search({ queries: [{ provider: "linear" }] });
      // Default: summary mode, no tools
      expect(result.results[0].count).toBe(0);
      expect(allTools(result.results[0])).toHaveLength(0);
    });
  });

  describe("summary mode behavior", () => {
    beforeEach(() => {
      registry.setToolsForSource("linear", [
        makeTool("linear__create_issue", "Create issue"),
        makeTool("linear__list_issues", "List issues"),
      ]);
    });

    it("does not claim tools in seenTools", () => {
      // Summary query for linear — should not mark tools as seen
      const result = service.search({
        queries: [
          { provider: "linear" },
          { provider: "linear", expand_tools: true },
        ],
      });
      // First query: summary, no tools
      expect(allTools(result.results[0])).toHaveLength(0);
      // Second query: expand, should get ALL tools (not deduped)
      expect(allTools(result.results[1])).toHaveLength(2);
    });

    it("does not auto-enable tools", () => {
      const callback = vi.fn();
      service.onVisibleToolsChanged(callback);

      service.search({ queries: [{ provider: "linear" }] });

      // No tools should be enabled
      const visible = service.getVisibleTools();
      expect(visible).toHaveLength(2); // only meta-tools
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

  it("search_tools call returns provider-grouped results", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__create_issue", "Create issue")] },
    ]);

    const result = await client.callTool({
      name: SEARCH_TOOL_NAME,
      arguments: { queries: [{ tool: "create" }] },
    });

    expect(result.content).toHaveLength(1);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].total).toBeGreaterThan(0);
    expect(parsed.results[0].providers.length).toBeGreaterThan(0);
    const tools = parsed.results[0].providers.flatMap((p: any) => p.tools);
    expect(tools[0].tool_name).toBe("linear__create_issue");

    await cleanup();
  });

  it("search by provider returns summary by default", async () => {
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
      arguments: { queries: [{ provider: "linear" }] },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsed.results[0].total).toBe(2);
    expect(parsed.results[0].count).toBe(0);
    expect(parsed.results[0].providers).toHaveLength(1);
    expect(parsed.results[0].providers[0].name).toBe("linear");
    expect(parsed.results[0].providers[0].tool_count).toBe(2);
    expect(parsed.results[0].providers[0].tools).toHaveLength(0);

    await cleanup();
  });

  it("search by provider with expand_tools returns tools", async () => {
    const { client, cleanup } = await createSearchTestPair([
      {
        source: "linear",
        tools: [
          makeTool("linear__create_issue", "Create issue"),
          makeTool("linear__list_issues", "List issues"),
        ],
      },
    ]);

    const result = await client.callTool({
      name: SEARCH_TOOL_NAME,
      arguments: { queries: [{ provider: "linear", expand_tools: true }] },
    });

    const parsed = JSON.parse(
      (result.content as Array<{ type: string; text: string }>)[0].text,
    );
    expect(parsed.results[0].total).toBe(2);
    expect(parsed.results[0].providers).toHaveLength(1);
    const tools = parsed.results[0].providers.flatMap((p: any) => p.tools);
    expect(tools).toHaveLength(2);
    expect(tools.every((t: any) => t.source === "linear")).toBe(true);

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
      arguments: { queries: [{ tool: "create" }] },
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
      arguments: { queries: [{ tool: "create" }] },
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
      arguments: { queries: [{ tool: "create" }] },
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

  it("search_tools with no queries returns error", async () => {
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

  it("search_tools with empty queries array returns error", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__tool")] },
    ]);

    const result = await client.callTool({
      name: SEARCH_TOOL_NAME,
      arguments: { queries: [] },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Error");
    expect(result.isError).toBe(true);

    await cleanup();
  });

  it("search_tools with query missing all filters returns error", async () => {
    const { client, cleanup } = await createSearchTestPair([
      { source: "linear", tools: [makeTool("linear__tool")] },
    ]);

    const result = await client.callTool({
      name: SEARCH_TOOL_NAME,
      arguments: { queries: [{}] },
    });

    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Error");
    expect(text).toContain("queries[0]");
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
