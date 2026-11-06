import type { Tool } from "@modelcontextprotocol/client";
import type { PolicyEngine } from "../../policy/index.js";
import { ToolSearchService, type SearchToolsParams, type SearchToolsResponse } from "../../search/index.js";
import { SEARCH_TIME_LIMIT_MS, timeLimit } from "../../search/limits.js";
import { prefixOrRegex } from "../../search/search-pattern.js";
import type { QueryResult, SearchQuery } from "../../search/types.js";
import { listedStatus, providerStatus, withoutCredentials } from "../../server/server-list.js";
import { namespaceTool } from "../../server/tool-namespacing.js";
import { ToolRegistry } from "../../server/tool-registry.js";
import type { ConnectionStatus } from "../../upstream/types.js";
import { canonicalize } from "../../upstream/upstream-hash.js";
import { capStderrLine, type UpstreamSnapshot } from "../protocol.js";

/** The most of a server's last connection error a search shows. */
export const MAX_SEARCHED_ERROR_CHARS = 500;

interface Followed {
  /** As `listedStatus` shows it. */
  status: ConnectionStatus;
  error: string | undefined;
  /** The tools indexed for the server, or undefined when none are. */
  toolsText: string | undefined;
}

/**
 * An instance's searchable tools, under the names its config gives its
 * servers. A server's tools are searchable while it is connected or
 * reconnecting after a drop, and leave the index once an attempt to connect
 * fails or it needs authorization; tools whose policy is `never` are shown
 * disabled.
 */
export class ToolIndex {
  private readonly _registry = new ToolRegistry();
  private readonly _search: ToolSearchService;
  private readonly _followed = new Map<string, Followed>();

  constructor(policy: PolicyEngine) {
    this._search = new ToolSearchService(this._registry, policy);
  }

  /** Follows a server's snapshots: indexes its tools when they change or it connects again, and drops them once an attempt to connect fails or it needs authorization. */
  follow(name: string, snapshot: Pick<UpstreamSnapshot, "status" | "tools" | "error">): void {
    const seen = this._followed.get(name);
    const status = listedStatus(snapshot.status, snapshot.error);
    let toolsText = seen?.toolsText;
    if (status === "connected") {
      const current = canonicalize(snapshot.tools);
      if (current !== toolsText) this._setTools(name, snapshot.tools);
      toolsText = current;
    } else if (status !== "connecting" && toolsText !== undefined) {
      this._dropTools(name);
      toolsText = undefined;
    }
    this._followed.set(name, { status, error: snapshot.error, toolsText });
  }

  setCategory(name: string, category: string | undefined): void {
    if (category === this._registry.getCategoryForSource(name)) return;
    if (category === undefined) this._registry.removeCategoryForSource(name);
    else this._registry.setCategoryForSource(name, category);
    this._search.refresh();
  }

  remove(name: string): void {
    this._followed.delete(name);
    this._registry.removeSource(name);
    this._registry.removeCategoryForSource(name);
    this._search.refresh();
  }

  /** Searches the tools; a query whose provider filter matches a server that isn't connected also gets that server's status and why. */
  search(params: SearchToolsParams): SearchToolsResponse {
    const { results } = this._search.search(params);
    const checkTimeLimit = timeLimit(SEARCH_TIME_LIMIT_MS);
    return { results: results.map((result, at) => this._withStatuses(result, params.queries[at], checkTimeLimit)) };
  }

  close(): void {
    this._search.dispose();
  }

  private _withStatuses(result: QueryResult, query: SearchQuery | undefined, checkTimeLimit: () => void): QueryResult {
    if (query?.provider === undefined || query.provider === "" || (query.offset ?? 0) > 0) return result;
    const providerPattern = prefixOrRegex(query.provider, checkTimeLimit);
    const categoryPattern = query.category === undefined || query.category === "" ? undefined : prefixOrRegex(query.category, checkTimeLimit);
    const providers = [...result.providers];
    for (const [name, { status, error, toolsText }] of this._followed) {
      if (status === "connected" || !providerPattern.test(name)) continue;
      const category = this._registry.getCategoryForSource(name);
      if (categoryPattern !== undefined && (category === undefined || !categoryPattern.test(category))) continue;
      const hasTools = toolsText !== undefined;
      const shownError = error === undefined ? undefined : capStderrLine(withoutCredentials(error), MAX_SEARCHED_ERROR_CHARS);
      const note = providerStatus(name, status, shownError, hasTools);
      const at = providers.findIndex((entry) => entry.name === name);
      if (at >= 0) {
        providers[at] = { ...providers[at]!, ...note };
        continue;
      }
      providers.push({ name, ...(category !== undefined && { category }), tool_count: hasTools ? this._tools(name).length : 0, tools: [], ...note });
    }
    return { ...result, providers };
  }

  /** The tools of server `name`, under their namespaced names. */
  private _tools(name: string): Tool[] {
    return this._registry.listRegisteredTools().filter(({ source }) => source === name).map(({ tool }) => tool);
  }

  private _setTools(name: string, tools: ReadonlyArray<Tool>): void {
    this._registry.setToolsForSource(
      name,
      tools.map((tool) => namespaceTool(name, tool)),
    );
  }

  private _dropTools(name: string): void {
    const category = this._registry.getCategoryForSource(name);
    this._registry.removeSource(name);
    if (category !== undefined) this._registry.setCategoryForSource(name, category);
  }
}
