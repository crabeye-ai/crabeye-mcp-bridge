import { describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { createTestPair, makeTool } from "../_helpers/bridge-test-pair.js";
import { errorResult } from "../_helpers/run-tool.js";
import { localSearch } from "../_helpers/local-search.js";

type Pair = Awaited<ReturnType<typeof createTestPair>>;

const searchText = async ({ client }: Pair, queries: unknown[]) =>
  (await client.callTool({ name: "search_tools", arguments: { queries } })) as { content: Array<{ text: string }>; isError?: boolean };

describe("search_tools on the bridge", () => {
  it.each([
    ["more than 64 queries", Array.from({ length: 65 }, () => ({ tool: "x" })), "Error: at most 64 queries per search."],
    ["a term over 1024 bytes", [{ tool: "x" }, { provider: "é".repeat(513) }], "Error: queries[1].provider is longer than 1024 bytes."],
  ])("refuses %s before asking the manager, saying so", async (_case, queries, message) => {
    const search = vi.fn(localSearch());
    const pair = await createTestPair({ search });

    expect(await searchText(pair, queries)).toMatchObject(errorResult(message));
    expect(search).not.toHaveBeenCalled();
    await pair.cleanup();
  });

  it.each([
    ["exactly 64 queries", Array.from({ length: 64 }, () => ({ tool: "x" }))],
    ["a term of exactly 1024 bytes", [{ provider: "é".repeat(512) }]],
  ])("asks the manager for a search with %s", async (_case, queries) => {
    const search = vi.fn(localSearch());
    const pair = await createTestPair({ search });

    expect((await searchText(pair, queries)).isError).not.toBe(true);
    expect(search).toHaveBeenCalledOnce();
    await pair.cleanup();
  });

  it("says why tools can't be searched when the manager can't answer", async () => {
    const pair = await createTestPair({ search: async () => Promise.reject(new Error("daemon did not become reachable within timeout")) });

    expect(await searchText(pair, [{ provider: "linear" }])).toMatchObject(
      errorResult("Error: tools can't be searched: daemon did not become reachable within timeout"),
    );
    await pair.cleanup();
  });

  it("counts only its own client's searches in --stats when another client searches the same index", async () => {
    const registry = new ToolRegistry();
    registry.setToolsForSource("linear", [makeTool("linear__create_issue"), makeTool("linear__list_issues")]);
    const search = localSearch(registry);
    const [busy, quiet] = [await createTestPair({ registry, search, showStats: true }), await createTestPair({ registry, search, showStats: true })];

    for (let i = 0; i < 3; i++) await searchText(busy, [{ provider: "linear", expand_tools: true }]);
    const stats = async (pair: Pair) => JSON.parse((await searchText(pair, [{ provider: "linear" }])).content[0]!.text).session_stats;
    const [busyStats, quietStats] = [await stats(busy), await stats(quiet)];

    expect(busyStats.baseline_tokens).toBe(quietStats.baseline_tokens);
    expect(busyStats.bridge_tokens).toBeGreaterThan(quietStats.bridge_tokens);
    await busy.cleanup();
    await quiet.cleanup();
  });
});
