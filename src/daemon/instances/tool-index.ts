import type { Tool } from "@modelcontextprotocol/client";
import type { PolicyEngine } from "../../policy/index.js";
import { ToolSearchService, type SearchToolsParams, type SearchToolsResponse } from "../../search/index.js";
import { namespaceTool } from "../../server/tool-namespacing.js";
import { ToolRegistry } from "../../server/tool-registry.js";
import { canonicalize } from "../../upstream/upstream-hash.js";
import type { UpstreamSnapshot } from "../protocol.js";

/**
 * An instance's searchable tools, under the names its config gives its
 * servers. A server's tools stay searchable while it is disconnected, until
 * it is removed; tools whose policy is `never` are shown disabled.
 */
export class ToolIndex {
  private readonly _registry = new ToolRegistry();
  private readonly _search: ToolSearchService;
  private readonly _followed = new Map<string, { connected: boolean; toolsText: string | undefined }>();

  constructor(policy: PolicyEngine) {
    this._search = new ToolSearchService(this._registry, policy);
  }

  /** Indexes a server's tools from its snapshots, as a bridge's stand-in takes them: when they change, or when it connects again. */
  follow(name: string, snapshot: Pick<UpstreamSnapshot, "status" | "tools">): void {
    const seen = this._followed.get(name) ?? { connected: false, toolsText: undefined };
    const connected = snapshot.status === "connected";
    if (connected) {
      const toolsText = canonicalize(snapshot.tools);
      if (!seen.connected || toolsText !== seen.toolsText) this._setTools(name, snapshot.tools);
      seen.toolsText = toolsText;
    }
    seen.connected = connected;
    this._followed.set(name, seen);
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

  /** The tools of server `name`, under their namespaced names. */
  tools(name: string): Tool[] {
    return this._registry.listRegisteredTools().filter(({ source }) => source === name).map(({ tool }) => tool);
  }

  search(params: SearchToolsParams): SearchToolsResponse {
    return this._search.search(params);
  }

  close(): void {
    this._search.dispose();
  }

  private _setTools(name: string, tools: ReadonlyArray<Tool>): void {
    this._registry.setToolsForSource(
      name,
      tools.map((tool) => namespaceTool(name, tool)),
    );
  }
}
