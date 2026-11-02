import MiniSearch from "minisearch";
import type { ToolRegistry } from "../server/tool-registry.js";
import { parseNamespacedName } from "../server/tool-namespacing.js";
import type { PolicyEngine } from "../policy/index.js";
import { parseRegex, prefixOrRegex } from "./search-pattern.js";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_SEARCHED_DESCRIPTION_CHARS,
  MAX_SEARCHED_NAME_BYTES,
  MAX_SEARCHED_WORD_CHARS,
  SEARCH_TIME_LIMIT_MS,
  timeLimit,
} from "./limits.js";
import type { ProviderResult, QueryResult, SearchToolResult, SearchToolsParams, SearchToolsResponse } from "./types.js";

interface IndexedTool {
  id: string;
  name: string;
  originalName: string;
  description: string;
  /** The part of the description that is searched. */
  searchedDescription: string;
  source: string;
  category: string;
}

const SCORE_CUTOFF = 0.3;

function tokenize(text: string): string[] {
  return text
    .split(/[\s_\-./]+/)
    .filter(Boolean)
    .map((word) => word.slice(0, MAX_SEARCHED_WORD_CHARS));
}

function fingerprintTools(
  registered: ReadonlyArray<{ source: string; tool: { name: string; description?: string } }>,
  getCategory: (source: string) => string,
): string {
  // Stable order: registry returns Map insertion order which can differ
  // across rebuilds, so sort by (source, name) to keep the fingerprint
  // resilient to re-registration order changes that don't alter content.
  const rows = registered
    .map(({ source, tool }) =>
      [source, tool.name, tool.description ?? "", getCategory(source)].join("\x1f"),
    )
    .sort();
  return `${rows.length}|${rows.join("\x1e")}`;
}

export class ToolSearchService {
  private registry: ToolRegistry;
  private index: MiniSearch<IndexedTool>;
  private indexedTools = new Map<string, IndexedTool>();
  private unsubscribeRegistry: () => void;
  private policyEngine: PolicyEngine | undefined;
  /**
   * Fingerprint of the last indexed state. A buggy upstream that spams
   * `notifications/tools/list_changed` (some servers do this on every tool
   * call) used to drive a full minisearch tear-down + re-add per notify
   * even when the tool list was byte-identical. We skip the rebuild when
   * the fingerprint is unchanged.
   */
  private lastFingerprint = "";
  /** Changes are indexed at the next search, so a burst of them costs one rebuild. */
  private stale = true;

  constructor(registry: ToolRegistry, policyEngine?: PolicyEngine) {
    this.registry = registry;
    this.policyEngine = policyEngine;
    this.index = this.createIndex();
    this.unsubscribeRegistry = this.registry.onChanged(() => {
      this.stale = true;
    });
  }

  private createIndex(): MiniSearch<IndexedTool> {
    return new MiniSearch<IndexedTool>({
      fields: ["name", "originalName", "searchedDescription", "source"],
      storeFields: ["name", "originalName", "description", "source", "category"],
      searchOptions: {
        boost: { name: 3, originalName: 3, searchedDescription: 1, source: 0.5 },
        tokenize: (text) => [...new Set(tokenize(text).map((term) => term.toLowerCase()))],
        prefix: (term) => term.length >= 3,
        fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
        combineWith: "AND",
      },
      tokenize,
    });
  }

  private rebuildIndex(): void {
    this.stale = false;
    const registered = this.registry.listRegisteredTools();
    // Cheap content fingerprint: source + name + description + category.
    // Skips the expensive minisearch teardown + re-add when an upstream
    // re-emits an identical tool list. Description is included so a tool
    // whose description changed (with the same name) still rebuilds.
    const fingerprint = fingerprintTools(registered, (s) =>
      this.registry.getCategoryForSource(s) ?? "",
    );
    if (fingerprint === this.lastFingerprint) return;
    this.lastFingerprint = fingerprint;

    this.index.removeAll();
    this.indexedTools.clear();

    for (const { source, tool } of registered) {
      const parsed = parseNamespacedName(tool.name);
      const originalName = parsed?.toolName ?? tool.name;
      if (Buffer.byteLength(originalName) > MAX_SEARCHED_NAME_BYTES) continue;
      const category = this.registry.getCategoryForSource(source) ?? "";

      const doc: IndexedTool = {
        id: tool.name,
        name: tool.name,
        originalName,
        description: tool.description ?? "",
        searchedDescription: (tool.description ?? "").slice(0, MAX_SEARCHED_DESCRIPTION_CHARS),
        source,
        category,
      };
      this.indexedTools.set(tool.name, doc);
      this.index.add(doc);
    }
  }

  /** Runs `params`' queries; throws `SearchTimeoutError` when they take longer than `SEARCH_TIME_LIMIT_MS`. */
  search(params: SearchToolsParams): SearchToolsResponse {
    if (this.stale) this.rebuildIndex();
    const queries = params.queries;
    const checkTimeLimit = timeLimit(SEARCH_TIME_LIMIT_MS);

    if (!queries || queries.length === 0) {
      return { results: [] };
    }

    // Compute total tool count per source (for ProviderResult.tool_count)
    const sourceToolCounts = new Map<string, number>();
    for (const doc of this.indexedTools.values()) {
      sourceToolCounts.set(doc.source, (sourceToolCounts.get(doc.source) ?? 0) + 1);
    }

    const seenTools = new Set<string>();
    const results: QueryResult[] = [];

    for (const query of queries) {
      checkTimeLimit();
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
      const providerPattern = hasProviderFilter ? prefixOrRegex(query.provider!, checkTimeLimit) : undefined;
      const categoryPattern = hasCategoryFilter ? prefixOrRegex(query.category!, checkTimeLimit) : undefined;

      if (isSummary) {
        // Summary mode: provider summaries only, no tool details
        const matchedSources = new Set<string>();
        for (const doc of this.indexedTools.values()) {
          if (providerPattern && !providerPattern.test(doc.source)) continue;
          if (categoryPattern && (!doc.category || !categoryPattern.test(doc.category))) continue;
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
        // Do NOT add to seenTools in summary mode
        continue;
      }

      // Detail mode: collect candidate tools, then group by provider
      let toolCandidates: Set<string> | null = null;
      let providerCandidates: Set<string> | null = null;
      let categoryCandidates: Set<string> | null = null;

      if (hasToolFilter) {
        toolCandidates = new Set<string>();
        const regex = parseRegex(query.tool!, checkTimeLimit);
        if (regex) {
          for (const [name, doc] of this.indexedTools) {
            if (
              regex.test(doc.name) ||
              regex.test(doc.originalName) ||
              regex.test(doc.searchedDescription) ||
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

      if (providerPattern) {
        providerCandidates = new Set<string>();
        for (const [name, doc] of this.indexedTools) {
          if (providerPattern.test(doc.source)) {
            providerCandidates.add(name);
          }
        }
      }

      if (categoryPattern) {
        categoryCandidates = new Set<string>();
        for (const [name, doc] of this.indexedTools) {
          if (doc.category && categoryPattern.test(doc.category)) {
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

      for (const name of deduped) {
        seenTools.add(name);
      }
    }

    return { results };
  }

  /** Indexes the registry again at the next search, for a category change, which the registry doesn't announce. */
  refresh(): void {
    this.stale = true;
  }

  dispose(): void {
    this.unsubscribeRegistry();
  }
}
