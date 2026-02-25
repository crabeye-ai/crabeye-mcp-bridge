import MiniSearch from "minisearch";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistry } from "../server/tool-registry.js";
import { parseNamespacedName } from "../server/tool-namespacing.js";
import type { PolicyEngine } from "../policy/index.js";

export interface SearchQuery {
  tool?: string;
  provider?: string;
  category?: string;
  expand_tools?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchToolsParams {
  queries: SearchQuery[];
}

export interface SearchToolResult {
  tool_name: string;
  source: string;
  description: string;
  input_schema: object;
  disabled?: true;
}

export interface ProviderResult {
  name: string;
  category?: string;
  tool_count: number;
  tools: SearchToolResult[];
}

export interface QueryResult {
  providers: ProviderResult[];
  total: number;
  count: number;
  remaining: number;
  offset: number;
  limit: number;
}

export interface SearchToolsResponse {
  results: QueryResult[];
}

type VisibleToolsChangedCallback = () => void;

interface IndexedTool {
  id: string;
  name: string;
  originalName: string;
  description: string;
  source: string;
  category: string;
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;
const SCORE_CUTOFF = 0.3;

const MAX_REGEX_LEN = 200;

function parseRegex(input: string): RegExp | null {
  // Support "regex:pattern" prefix (preferred) and legacy /pattern/flags format
  let pattern: string;
  let flags = "";

  if (input.startsWith("regex:")) {
    pattern = input.slice(6);
  } else {
    const match = /^\/(.+)\/([gimsuy]*)$/.exec(input);
    if (!match) return null;
    pattern = match[1];
    flags = match[2];
  }

  if (!pattern || pattern.length > MAX_REGEX_LEN) return null;

  try {
    // Use 'v' flag (unicode sets) for linear-time guarantee where available,
    // fall back to plain construction on older runtimes.
    try {
      return new RegExp(pattern, flags + "v");
    } catch {
      return new RegExp(pattern, flags);
    }
  } catch {
    return null;
  }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function matchesPrefixOrRegex(value: string, pattern: string): boolean {
  const regex = parseRegex(pattern);
  if (regex) return regex.test(value);
  return value.toLowerCase().startsWith(pattern.toLowerCase());
}

export const SEARCH_TOOL_NAME = "search_tools";
export const RUN_TOOL_NAME = "run_tool";

export const searchToolDefinition: Tool = {
  name: SEARCH_TOOL_NAME,
  description: [
    "Search for available tools across all connected MCP servers. ALWAYS call this BEFORE claiming a tool is unavailable, before web search fallback, or when the user mentions any service/tool/integration.",
    "",
    "Discovery workflow:",
    "1. Search by provider or category to get provider summaries (tool counts, no details)",
    "2. If you need the tools, drill in with a tool filter or expand_tools: true to get full tool definitions",
    "",
    "When to use:",
    "- User mentions a service or tool by name — search by provider name first",
    "- User wants to perform an action (create, update, query, etc.) — search by tool keyword",
    "- User asks what tools or integrations are available — search by provider or category for summaries",
    "- User asks 'can you...?' about external capabilities — search before answering",
    "- You need a tool you haven't seen yet — many tools are available but not listed until searched",
    "",
    "Response shape: results[].providers[].tools[]",
    "Without a tool filter, only provider summaries are returned (name, category, tool_count). Use a tool query or expand_tools: true to get full tool definitions.",
    "Use text queries for fuzzy search or prefix with regex: for precise pattern matching.",
    "Each query object can have its own filters and pagination.",
  ].join("\n"),
  inputSchema: {
    type: "object" as const,
    properties: {
      queries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            tool: {
              type: "string",
              description:
                "Text search query to match tool names and descriptions. " +
                "Prefix with regex: for regex matching (e.g. \"regex:.*issue.*\"). " +
                "Prefer passing several queries covering synonyms and related terms to minimize round-trips.",
            },
            provider: {
              type: "string",
              description:
                "Filter by upstream server/provider name. " +
                "Prefix match by default (e.g. \"git\" matches \"github\"). " +
                "Use regex: prefix for patterns (e.g. \"regex:^(linear|figma)$\").",
            },
            category: {
              type: "string",
              description:
                "Filter by tool category (configured via _bridge.category in server config). " +
                "Prefix match by default. Use regex: prefix for patterns.",
            },
            expand_tools: {
              type: "boolean",
              description:
                "When true, return full tool definitions for all tools from matched providers. " +
                "Without this, provider-only queries return summaries (name, tool_count) without tool details. " +
                "Ignored when a tool filter is present (tool filter always returns details).",
            },
            limit: {
              type: "number",
              description: `Maximum number of tool results for this query (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
            },
            offset: {
              type: "number",
              description: "Number of tool results to skip for pagination (default 0)",
            },
          },
        },
        description:
          "Array of query objects. Each query is self-contained with its own filters and pagination. " +
          "Results are deduplicated across queries — first query wins. " +
          "Each query must have at least one of: tool, provider, category.",
      },
    },
    required: ["queries"],
  },
};

export const runToolDefinition: Tool = {
  name: RUN_TOOL_NAME,
  description: [
    "Execute any tool from any connected MCP server by its full namespaced name (provider__tool_name format).",
    "Use this after discovering tools via search_tools. The tool does not need to be enabled first.",
    "Pass the exact namespaced name from search results and the required arguments.",
  ].join("\n"),
  inputSchema: {
    type: "object" as const,
    properties: {
      name: {
        type: "string",
        description:
          "The full namespaced tool name to call (e.g. 'linear__create_issue')",
      },
      arguments: {
        type: "object",
        description: "Arguments to pass to the tool",
      },
    },
    required: ["name"],
  },
};

export class ToolSearchService {
  private registry: ToolRegistry;
  private index: MiniSearch<IndexedTool>;
  private indexedTools = new Map<string, IndexedTool>();
  private enabledTools = new Set<string>();
  private listeners = new Set<VisibleToolsChangedCallback>();
  private unsubscribeRegistry: () => void;
  private policyEngine: PolicyEngine | undefined;

  constructor(registry: ToolRegistry, policyEngine?: PolicyEngine) {
    this.registry = registry;
    this.policyEngine = policyEngine;
    this.index = this.createIndex();
    this.rebuildIndex();
    this.unsubscribeRegistry = this.registry.onChanged(() => {
      this.rebuildIndex();
    });
  }

  private createIndex(): MiniSearch<IndexedTool> {
    return new MiniSearch<IndexedTool>({
      fields: ["name", "originalName", "description", "source"],
      storeFields: ["name", "originalName", "description", "source", "category"],
      searchOptions: {
        boost: { name: 3, originalName: 3, description: 1, source: 0.5 },
        prefix: (term) => term.length >= 3,
        fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
        combineWith: "AND",
      },
      tokenize: (text) => text.split(/[\s_\-./]+/).filter(Boolean),
    });
  }

  private rebuildIndex(): void {
    this.index.removeAll();
    this.indexedTools.clear();

    const registered = this.registry.listRegisteredTools();
    for (const { source, tool } of registered) {
      const parsed = parseNamespacedName(tool.name);
      const originalName = parsed?.toolName ?? tool.name;
      const category = this.registry.getCategoryForSource(source) ?? "";

      const doc: IndexedTool = {
        id: tool.name,
        name: tool.name,
        originalName,
        description: tool.description ?? "",
        source,
        category,
      };
      this.indexedTools.set(tool.name, doc);
      this.index.add(doc);
    }

    // Prune enabled tools that no longer exist
    let pruned = false;
    for (const name of this.enabledTools) {
      if (!this.indexedTools.has(name)) {
        this.enabledTools.delete(name);
        pruned = true;
      }
    }

    if (pruned) {
      this.notifyVisibleToolsChanged();
    }
  }

  search(params: SearchToolsParams): SearchToolsResponse {
    const queries = params.queries;

    if (!queries || queries.length === 0) {
      return { results: [] };
    }

    // Compute total tool count per source (for ProviderResult.tool_count)
    const sourceToolCounts = new Map<string, number>();
    for (const doc of this.indexedTools.values()) {
      sourceToolCounts.set(doc.source, (sourceToolCounts.get(doc.source) ?? 0) + 1);
    }

    const seenTools = new Set<string>();
    const allEnabled: string[] = [];
    const results: QueryResult[] = [];

    for (const query of queries) {
      const hasToolFilter = query.tool !== undefined && query.tool !== "";
      const hasProviderFilter = query.provider !== undefined && query.provider !== "";
      const hasCategoryFilter = query.category !== undefined && query.category !== "";
      const expandTools = query.expand_tools === true;

      // Query with no filters: return empty result for this slot
      if (!hasToolFilter && !hasProviderFilter && !hasCategoryFilter) {
        results.push({
          providers: [],
          total: 0,
          count: 0,
          remaining: 0,
          offset: query.offset ?? 0,
          limit: query.limit ?? DEFAULT_LIMIT,
        });
        continue;
      }

      const limit = Math.min(
        Math.max(1, query.limit ?? DEFAULT_LIMIT),
        MAX_LIMIT,
      );
      const offset = Math.max(0, query.offset ?? 0);
      const isSummary = !hasToolFilter && !expandTools;

      if (isSummary) {
        // Summary mode: provider summaries only, no tool details
        const matchedSources = new Set<string>();
        for (const doc of this.indexedTools.values()) {
          if (hasProviderFilter && !matchesPrefixOrRegex(doc.source, query.provider!)) continue;
          if (hasCategoryFilter && (!doc.category || !matchesPrefixOrRegex(doc.category, query.category!))) continue;
          matchedSources.add(doc.source);
        }

        const providers: ProviderResult[] = [];
        let totalToolCount = 0;
        for (const source of matchedSources) {
          const count = sourceToolCounts.get(source) ?? 0;
          const category = this.registry.getCategoryForSource(source);
          providers.push({
            name: source,
            ...(category ? { category } : {}),
            tool_count: count,
            tools: [],
          });
          totalToolCount += count;
        }

        results.push({
          providers,
          total: totalToolCount,
          count: 0,
          remaining: 0,
          offset,
          limit,
        });
        // Do NOT add to seenTools or allEnabled in summary mode
        continue;
      }

      // Detail mode: collect candidate tools, then group by provider
      let toolCandidates: Set<string> | null = null;
      let providerCandidates: Set<string> | null = null;
      let categoryCandidates: Set<string> | null = null;

      if (hasToolFilter) {
        toolCandidates = new Set<string>();
        const regex = parseRegex(query.tool!);
        if (regex) {
          for (const [name, doc] of this.indexedTools) {
            if (
              regex.test(doc.name) ||
              regex.test(doc.originalName) ||
              regex.test(doc.description) ||
              regex.test(doc.source)
            ) {
              toolCandidates.add(name);
            }
          }
        } else {
          const searchResults = this.index.search(query.tool!);
          if (searchResults.length > 0) {
            const topScore = searchResults[0].score;
            const threshold = topScore * SCORE_CUTOFF;
            for (const r of searchResults) {
              if (r.score >= threshold) {
                toolCandidates.add(r.id as string);
              }
            }
          }
        }
      }

      if (hasProviderFilter) {
        providerCandidates = new Set<string>();
        for (const [name, doc] of this.indexedTools) {
          if (matchesPrefixOrRegex(doc.source, query.provider!)) {
            providerCandidates.add(name);
          }
        }
      }

      if (hasCategoryFilter) {
        categoryCandidates = new Set<string>();
        for (const [name, doc] of this.indexedTools) {
          if (doc.category && matchesPrefixOrRegex(doc.category, query.category!)) {
            categoryCandidates.add(name);
          }
        }
      }

      // Intersect all non-null filter sets (AND logic within a query)
      const filterSets = [toolCandidates, providerCandidates, categoryCandidates].filter(
        (s): s is Set<string> => s !== null,
      );

      let candidates: Set<string>;
      if (filterSets.length === 0) {
        candidates = new Set();
      } else if (filterSets.length === 1) {
        candidates = filterSets[0];
      } else {
        // Intersect: start with smallest set for efficiency
        const sorted = filterSets.sort((a, b) => a.size - b.size);
        candidates = new Set<string>();
        for (const name of sorted[0]) {
          if (sorted.every((s) => s.has(name))) {
            candidates.add(name);
          }
        }
      }

      // Deduplicate across queries — remove tools already seen
      const deduped: string[] = [];
      for (const name of candidates) {
        if (!seenTools.has(name)) {
          deduped.push(name);
        }
      }

      const total = deduped.length;
      const paged = deduped.slice(offset, offset + limit);

      // Pre-compute policy for each tool on the page
      const disabledSet = new Set<string>();
      if (this.policyEngine) {
        for (const name of paged) {
          const parsed = parseNamespacedName(name);
          if (parsed && this.policyEngine.resolvePolicy(parsed.source, parsed.toolName) === "never") {
            disabledSet.add(name);
          }
        }
      }

      // Build tools grouped by provider
      const providerToolsMap = new Map<string, SearchToolResult[]>();
      const providerOrder: string[] = [];

      for (const name of paged) {
        const doc = this.indexedTools.get(name);
        if (!doc) continue;
        const registered = this.registry.getTool(name);
        if (!registered) continue;

        if (!providerToolsMap.has(doc.source)) {
          providerToolsMap.set(doc.source, []);
          providerOrder.push(doc.source);
        }

        if (disabledSet.has(name)) {
          providerToolsMap.get(doc.source)!.push({
            tool_name: name,
            source: doc.source,
            description: "",
            input_schema: {},
            disabled: true,
          });
        } else {
          providerToolsMap.get(doc.source)!.push({
            tool_name: name,
            source: doc.source,
            description: doc.description,
            input_schema: registered.tool.inputSchema,
          });
        }
      }

      const providers: ProviderResult[] = [];
      for (const source of providerOrder) {
        const category = this.registry.getCategoryForSource(source);
        providers.push({
          name: source,
          ...(category ? { category } : {}),
          tool_count: sourceToolCounts.get(source) ?? 0,
          tools: providerToolsMap.get(source) ?? [],
        });
      }

      const toolCount = providers.reduce((sum, p) => sum + p.tools.length, 0);
      const remaining = Math.max(0, total - offset - toolCount);

      results.push({
        providers,
        total,
        count: toolCount,
        remaining,
        offset,
        limit,
      });

      // Mark tools as seen for deduplication, collect enabled tools
      for (const name of deduped) {
        seenTools.add(name);
      }

      // Only enable tools in the current page (skip disabled ones)
      for (const name of paged) {
        if (!disabledSet.has(name) && this.indexedTools.has(name) && this.registry.getTool(name)) {
          allEnabled.push(name);
        }
      }
    }

    // Cap total enabled tools at MAX_LIMIT
    const cappedEnabled = allEnabled.slice(0, MAX_LIMIT);

    const newEnabled = new Set(cappedEnabled);
    const changed = !setsEqual(this.enabledTools, newEnabled);
    this.enabledTools = newEnabled;

    if (changed) {
      this.notifyVisibleToolsChanged();
    }

    return { results };
  }

  getVisibleTools(): Tool[] {
    const tools: Tool[] = [searchToolDefinition, runToolDefinition];
    for (const name of this.enabledTools) {
      const registered = this.registry.getTool(name);
      if (registered) {
        tools.push(registered.tool);
      }
    }
    return tools;
  }

  onVisibleToolsChanged(callback: VisibleToolsChangedCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  dispose(): void {
    this.unsubscribeRegistry();
    this.listeners.clear();
  }

  private notifyVisibleToolsChanged(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listeners must not throw, but don't let one block others
      }
    }
  }
}
