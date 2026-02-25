import MiniSearch from "minisearch";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistry } from "../server/tool-registry.js";
import { parseNamespacedName } from "../server/tool-namespacing.js";
import type { PolicyEngine } from "../policy/index.js";

export interface SearchToolsParams {
  queries?: string[];
  providers?: string[];
  categories?: string[];
  limit?: number;
  offset?: number;
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
  tool_count: number;
  tools: string[];
}

export interface SearchToolsResponse {
  tools: SearchToolResult[];
  providers: ProviderResult[];
  auto_enabled: string[];
  total: number;
  limit: number;
  offset: number;
  count: number;
}

type VisibleToolsChangedCallback = () => void;

interface IndexedTool {
  id: string;
  name: string;
  originalName: string;
  description: string;
  source: string;
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

function matchesPattern(value: string, pattern: string): boolean {
  const regex = parseRegex(pattern);
  if (regex) return regex.test(value);
  return value.toLowerCase().includes(pattern.toLowerCase());
}

export const SEARCH_TOOL_NAME = "search_tools";
export const RUN_TOOL_NAME = "run_tool";

export const searchToolDefinition: Tool = {
  name: SEARCH_TOOL_NAME,
  description: [
    "Search for available tools across all connected MCP servers. ALWAYS call this BEFORE claiming a tool is unavailable, before web search fallback, or when the user mentions any service/tool/integration.",
    "",
    "When to use:",
    "- User mentions a service or tool by name — search by provider name",
    "- User wants to perform an action (create, update, query, send, manage, etc.) — search by action keywords",
    "- User asks what tools or integrations are available — search with broad queries",
    "- User asks 'can you...?' about external capabilities — search before answering",
    "- You need a tool you haven't seen yet — many tools are available but not listed until searched",
    "",
    "Returns matching tools with descriptions and input schemas, auto-enables them for immediate use.",
    "Use text queries for fuzzy search or prefix with regex: for precise pattern matching. Filter by provider or category.",
    "At least one of queries, providers, or categories must be specified.",
  ].join("\n"),
  inputSchema: {
    type: "object" as const,
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        description:
          "Text search queries to match tool names, descriptions, and provider names. " +
          "Prefix with regex: for regex matching (e.g. \"regex:.*issue.*\"). " +
          "Multiple queries are combined with OR — results matching any query are included. " +
          "Prefer passing several queries at once covering synonyms and related terms to minimize round-trips.",
      },
      providers: {
        type: "array",
        items: { type: "string" },
        description:
          "Search or filter by upstream server/provider name. " +
          "Supports exact names, substring matching, and regex: prefix for patterns. " +
          "Returns all tools from matching providers. " +
          'To list all providers, pass "regex:.*".',
      },
      categories: {
        type: "array",
        items: { type: "string" },
        description:
          "Search by tool category. Categories correspond to provider/source names. " +
          "Supports exact names, substring matching, and regex: prefix for patterns. " +
          "Functionally equivalent to providers — use whichever feels more natural.",
      },
      limit: {
        type: "number",
        description: `Maximum number of tool results to return (default ${DEFAULT_LIMIT} (recommended), max ${MAX_LIMIT})`,
      },
      offset: {
        type: "number",
        description: "Number of tool results to skip for pagination (default 0)",
      },
    },
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
      storeFields: ["name", "originalName", "description", "source"],
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

      const doc: IndexedTool = {
        id: tool.name,
        name: tool.name,
        originalName,
        description: tool.description ?? "",
        source,
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
    const { queries, providers, categories } = params;
    const hasQueries = queries && queries.length > 0;
    const hasProviders = providers && providers.length > 0;
    const hasCategories = categories && categories.length > 0;

    if (!hasQueries && !hasProviders && !hasCategories) {
      return {
        tools: [],
        providers: [],
        auto_enabled: [],
        total: 0,
        limit: params.limit ?? DEFAULT_LIMIT,
        offset: params.offset ?? 0,
        count: 0,
      };
    }

    const limit = Math.min(
      Math.max(1, params.limit ?? DEFAULT_LIMIT),
      MAX_LIMIT,
    );
    const offset = Math.max(0, params.offset ?? 0);

    // Merge providers and categories into one list of source patterns
    const sourcePatterns: string[] = [
      ...(providers ?? []),
      ...(categories ?? []),
    ];

    // Collect candidate tool names from queries (OR across queries)
    let queryCandidates: Set<string> | null = null;

    if (hasQueries) {
      queryCandidates = new Set<string>();
      for (const query of queries) {
        const regex = parseRegex(query);
        if (regex) {
          for (const [name, doc] of this.indexedTools) {
            if (
              regex.test(doc.name) ||
              regex.test(doc.originalName) ||
              regex.test(doc.description) ||
              regex.test(doc.source)
            ) {
              queryCandidates.add(name);
            }
          }
        } else {
          const results = this.index.search(query);
          if (results.length > 0) {
            const topScore = results[0].score;
            const threshold = topScore * SCORE_CUTOFF;
            for (const result of results) {
              if (result.score >= threshold) {
                queryCandidates.add(result.id as string);
              }
            }
          }
        }
      }
    }

    // Collect tool names matching source patterns
    let sourceCandidates: Set<string> | null = null;

    if (sourcePatterns.length > 0) {
      sourceCandidates = new Set<string>();
      for (const pattern of sourcePatterns) {
        for (const [name, doc] of this.indexedTools) {
          if (matchesPattern(doc.source, pattern)) {
            sourceCandidates.add(name);
          }
        }
      }
    }

    // Combine: if both queries and source patterns given, intersect them;
    // otherwise use whichever is available
    let candidates: Set<string>;
    if (queryCandidates !== null && sourceCandidates !== null) {
      candidates = new Set<string>();
      for (const name of queryCandidates) {
        if (sourceCandidates.has(name)) {
          candidates.add(name);
        }
      }
    } else {
      candidates = queryCandidates ?? sourceCandidates ?? new Set();
    }

    const allMatched = Array.from(candidates);
    const total = allMatched.length;

    // Provider/category-only search: return just provider names and tool counts
    const providerOnly = !hasQueries && (hasProviders || hasCategories);

    if (providerOnly) {
      const providerResults = this.buildProviderResults(allMatched, sourcePatterns)
        .map(({ name, tool_count }) => ({ name, tool_count, tools: [] as string[] }));
      return {
        tools: [],
        providers: providerResults,
        auto_enabled: [],
        total,
        limit,
        offset,
        count: 0,
      };
    }

    const paged = allMatched.slice(offset, offset + limit);

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

    const tools: SearchToolResult[] = [];
    for (const name of paged) {
      const doc = this.indexedTools.get(name);
      if (!doc) continue;
      const registered = this.registry.getTool(name);
      if (!registered) continue;

      if (disabledSet.has(name)) {
        tools.push({
          tool_name: name,
          source: doc.source,
          description: "",
          input_schema: {},
          disabled: true,
        });
      } else {
        tools.push({
          tool_name: name,
          source: doc.source,
          description: doc.description,
          input_schema: registered.tool.inputSchema,
        });
      }
    }

    // Build provider results from all matched tools (not just the page)
    const providerResults = this.buildProviderResults(allMatched, sourcePatterns);

    // Only enable tools in the current page (skip disabled ones)
    const pagedNames = paged.filter(
      (name) => this.indexedTools.has(name) && this.registry.getTool(name) && !disabledSet.has(name),
    );
    const newEnabled = new Set(pagedNames);
    const changed = !setsEqual(this.enabledTools, newEnabled);
    this.enabledTools = newEnabled;

    if (changed) {
      this.notifyVisibleToolsChanged();
    }

    return {
      tools,
      providers: providerResults,
      auto_enabled: pagedNames,
      total,
      limit,
      offset,
      count: tools.length,
    };
  }

  private buildProviderResults(
    matchedToolNames: string[],
    sourcePatterns: string[],
  ): ProviderResult[] {
    // Collect providers that either have matched tools or match the source patterns
    const providerToolsMap = new Map<string, string[]>();

    // From matched tools
    for (const name of matchedToolNames) {
      const doc = this.indexedTools.get(name);
      if (!doc) continue;
      let list = providerToolsMap.get(doc.source);
      if (!list) {
        list = [];
        providerToolsMap.set(doc.source, list);
      }
      list.push(name);
    }

    // Also include providers matched by source patterns even if they have
    // zero tool matches (e.g. when intersected with queries).
    // This lets the LLM discover providers even when no tools match the query.
    const allSources = this.registry.listSources();
    const sourceMap = new Map(allSources.map((s) => [s.name, s]));

    if (sourcePatterns.length > 0) {
      for (const { name: sourceName } of allSources) {
        if (providerToolsMap.has(sourceName)) continue;
        for (const pattern of sourcePatterns) {
          if (matchesPattern(sourceName, pattern)) {
            providerToolsMap.set(sourceName, []);
            break;
          }
        }
      }
    }

    const results: ProviderResult[] = [];
    for (const [name, toolNames] of providerToolsMap) {
      const sourceInfo = sourceMap.get(name);
      results.push({
        name,
        tool_count: sourceInfo?.toolCount ?? toolNames.length,
        tools: toolNames,
      });
    }

    return results.sort((a, b) => b.tool_count - a.tool_count);
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
