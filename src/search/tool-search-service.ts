import MiniSearch from "minisearch";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRegistry } from "../server/tool-registry.js";
import { parseNamespacedName } from "../server/tool-namespacing.js";

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
const DEFAULT_LIMIT = 20;
const SCORE_CUTOFF = 0.3;

const MAX_REGEX_LEN = 200;

function parseRegex(input: string): RegExp | null {
  const match = /^\/(.+)\/([gimsuy]*)$/.exec(input);
  if (!match) return null;
  if (match[1].length > MAX_REGEX_LEN) return null;
  try {
    // Use 'v' flag (unicode sets) for linear-time guarantee where available,
    // fall back to plain construction on older runtimes.
    try {
      return new RegExp(match[1], match[2] + "v");
    } catch {
      return new RegExp(match[1], match[2]);
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

export const searchToolDefinition: Tool = {
  name: SEARCH_TOOL_NAME,
  description:
    "Search for available tools, providers, and categories across all connected upstream MCP servers. " +
    "Returns matching tools with descriptions and auto-enables them for use. " +
    "Also returns matching provider information (name, tool count, tool list). " +
    "Use text queries for fuzzy name/description search, or /regex/ patterns for precise matching. " +
    "Filter by provider or category to scope results to specific servers. " +
    "At least one of queries, providers, or categories must be specified.",
  inputSchema: {
    type: "object" as const,
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        description:
          "Text search queries or /regex/flags patterns to match tool names, descriptions, and provider names. " +
          "Multiple queries are combined with OR — results matching any query are included.",
      },
      providers: {
        type: "array",
        items: { type: "string" },
        description:
          "Search or filter by upstream server/provider name. " +
          "Supports exact names, substring matching, and /regex/flags patterns. " +
          "Returns all tools from matching providers.",
      },
      categories: {
        type: "array",
        items: { type: "string" },
        description:
          "Search by tool category. Categories correspond to provider/source names. " +
          "Supports exact names, substring matching, and /regex/flags patterns. " +
          "Functionally equivalent to providers — use whichever feels more natural.",
      },
      limit: {
        type: "number",
        description: `Maximum number of tool results to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`,
      },
      offset: {
        type: "number",
        description: "Number of tool results to skip for pagination (default 0)",
      },
    },
  },
};

export class ToolSearchService {
  private index: MiniSearch<IndexedTool>;
  private indexedTools = new Map<string, IndexedTool>();
  private enabledTools = new Set<string>();
  private listeners = new Set<VisibleToolsChangedCallback>();
  private unsubscribeRegistry: () => void;

  constructor(private registry: ToolRegistry) {
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
    const paged = allMatched.slice(offset, offset + limit);

    const tools: SearchToolResult[] = [];
    for (const name of paged) {
      const doc = this.indexedTools.get(name);
      if (!doc) continue;
      const registered = this.registry.getTool(name);
      if (!registered) continue;

      tools.push({
        tool_name: name,
        source: doc.source,
        description: doc.description,
        input_schema: registered.tool.inputSchema,
      });
    }

    // Build provider results from all matched tools (not just the page)
    const providerResults = this.buildProviderResults(allMatched, sourcePatterns);

    // Replace enabled tools with this result set (full match set, not just the page)
    const newEnabled = new Set(allMatched);
    const changed = !setsEqual(this.enabledTools, newEnabled);
    this.enabledTools = newEnabled;

    if (changed) {
      this.notifyVisibleToolsChanged();
    }

    return {
      tools,
      providers: providerResults,
      auto_enabled: allMatched,
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
    const tools: Tool[] = [searchToolDefinition];
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
