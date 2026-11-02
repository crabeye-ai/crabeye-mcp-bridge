import type { PolicyEngine } from "../../src/policy/index.js";
import { ToolSearchService, type SearchToolsParams, type SearchToolsResponse } from "../../src/search/index.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";

/** Answers `search_tools` from a registry in the test's own process, as the manager's instance does from its index. */
export function localSearch(registry = new ToolRegistry(), policy?: PolicyEngine): (params: SearchToolsParams) => Promise<SearchToolsResponse> {
  const service = new ToolSearchService(registry, policy);
  return async (params) => service.search(params);
}
