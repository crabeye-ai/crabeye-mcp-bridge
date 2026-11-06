import { afterEach, describe, expect, it } from "vitest";
import { BridgeConfigSchema, resolveUpstreams, serverBridgeConfigs } from "../../../src/config/schema.js";
import type { SearchToolsResult, UpstreamSnapshot } from "../../../src/daemon/protocol.js";
import { PolicyEngine } from "../../../src/policy/index.js";
import { ToolSearchService, type ProviderResult, type SearchQuery } from "../../../src/search/index.js";
import { namespaceTool } from "../../../src/server/tool-namespacing.js";
import { ToolRegistry } from "../../../src/server/tool-registry.js";
import type { UpstreamLink, UpstreamView } from "../../../src/upstream/instance-link.js";
import { InstanceUpstreamClient } from "../../../src/upstream/instance-upstream-client.js";
import { fixtureSource, until, type AttachedBridge } from "../../_helpers/daemon-fixtures.js";
import { FAST_RECONNECT, StdioManagerHarness } from "../../_helpers/stdio-manager.js";

const isWindows = process.platform === "win32";

const QUERIES: SearchQuery[][] = [
  [{ provider: "lin" }],
  [{ category: "dev", expand_tools: true }],
  [{ category: "design" }, { provider: "regex:^(git|fig)" }],
  [{ tool: "crash", expand_tools: true }],
  [{ tool: "stderr" }],
  [{ tool: "regex:^s", limit: 2, offset: 1 }],
  [{ provider: "github", expand_tools: true, limit: 3 }, { provider: "github", expand_tools: true }],
  [{ tool: "plain" }, { category: "project" }, { provider: "figma", expand_tools: true, limit: 50, offset: 0 }],
  [{ provider: "missing", expand_tools: true }],
];

function withoutStatuses({ results }: SearchToolsResult): SearchToolsResult {
  const withoutStatus = (entry: ProviderResult) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "status" && key !== "message")) as ProviderResult;
  return { results: results.map((result) => ({ ...result, providers: result.providers.map(withoutStatus) })) };
}

/** The search a bridge answered before #230: stand-ins fed by the manager's snapshots, its registry and its policy. */
function searchAsTheBridgeDid(updates: UpstreamSnapshot[], servers: Record<string, unknown>): (queries: SearchQuery[]) => unknown {
  const config = BridgeConfigSchema.parse({ mcpServers: servers });
  const upstreams = resolveUpstreams(config);
  const registry = new ToolRegistry();
  const views = new Map<string, UpstreamView>();
  const link = { watch: (name: string, view: UpstreamView) => (views.set(name, view), () => {}) } as unknown as UpstreamLink;
  for (const [name, server] of Object.entries(upstreams)) {
    if (server._bridge?.category) registry.setCategoryForSource(name, server._bridge.category);
    new InstanceUpstreamClient({ name, link }).onToolsChanged((tools) => registry.setToolsForSource(name, tools.map((tool) => namespaceTool(name, tool))));
  }
  for (const update of updates) views.get(update.name)?.onSnapshot(update);
  const service = new ToolSearchService(registry, new PolicyEngine(config._bridge.toolPolicy, serverBridgeConfigs(upstreams)));
  return (queries) => service.search({ queries });
}

describe.skipIf(isWindows)("search_tools in the manager", { timeout: 30_000 }, () => {
  const h = new StdioManagerHarness();

  afterEach(() => h.cleanUp());

  it("answers every query as the bridge did, with categories, a disabled tool, paging, regex, de-duplication and a crashed server that keeps its tools while it reconnects", async () => {
    const server = (stub: string, arg: string, extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [stub, arg], _bridge: { ...FAST_RECONNECT, ...extra } });
    await h.start((stub) => ({
      linear: server(stub, "--linear", { category: "project management" }),
      github: server(stub, "--github", { category: "development", tools: { crash: "never" } }),
      figma: server(stub, "--figma", { category: "design", reconnect: { reconnectBaseDelay: 60_000, reconnectMaxDelay: 60_000 } }),
      down: { command: "/nonexistent/cbe-missing", _bridge: FAST_RECONNECT },
    }));
    const bridge: AttachedBridge = await h.attach();
    for (const name of ["linear", "github", "figma"]) await bridge.connected(name);
    await bridge.callTool("figma", "crash", { lines: [], code: 1 }).catch(() => {});
    await until(() => bridge.snapshots.get("figma")?.status === "disconnected");
    const servers = h.configs[fixtureSource.path]!;

    const expected = searchAsTheBridgeDid(bridge.updates, servers);
    for (const queries of QUERIES) {
      const actual = (await bridge.client.call("SEARCH_TOOLS", { queries })) as SearchToolsResult;
      expect(withoutStatuses(actual), JSON.stringify(queries)).toEqual(expected(queries));
    }
    const figma = (await bridge.client.call("SEARCH_TOOLS", { queries: [{ provider: "figma", expand_tools: true }] })) as SearchToolsResult;
    expect(figma.results[0]!.total).toBeGreaterThan(0);
    expect(figma.results[0]!.providers[0]).toMatchObject({ name: "figma", status: "starting", message: '"figma" is reconnecting; a call to its tools waits for it to be back.' });
  });
});
