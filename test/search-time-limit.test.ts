import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchTimeoutError } from "../src/search/limits.js";
import { ToolSearchService } from "../src/search/index.js";
import type { SearchQuery } from "../src/search/index.js";
import { ToolRegistry } from "../src/server/tool-registry.js";

describe("A search's time limit", () => {
  let service: ToolSearchService;

  beforeEach(() => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("svc", ["a", "b", "c"].map((name) => ({ name: `svc__${name}`, description: `Tool ${name}`, inputSchema: { type: "object" as const } })));
    registry.setCategoryForSource("svc", "tools");
    service = new ToolSearchService(registry);
    service.search({ queries: [{ provider: "svc" }] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function pastTheLimitAfter(checks: number): void {
    let calls = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (calls++ <= checks ? 0 : 3_000));
  }

  it.each<[string, SearchQuery[], number]>([
    ["between text queries", [{ tool: "tool" }, { tool: "tool" }], 1],
    ["between a tool regex's tests", [{ tool: "regex:^zzz" }], 2],
    ["between a provider regex's tests", [{ provider: "regex:^zzz" }], 2],
    ["between a category regex's tests", [{ category: "regex:^zzz" }], 2],
  ])("stops a search %s once it is past the limit", (_case, queries, checks) => {
    pastTheLimitAfter(checks);

    expect(() => service.search({ queries })).toThrow(SearchTimeoutError);
  });
});
