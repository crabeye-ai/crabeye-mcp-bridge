import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { BridgeConfigSchema } from "../../../src/config/schema.js";
import { ToolSearchService } from "../../../src/search/index.js";
import type { CredentialStore } from "../../../src/credentials/credential-store.js";
import { InstanceHost } from "../../../src/daemon/instances/instance-host.js";
import { MIN_BRIDGE_PROTOCOL_VERSION, type SearchToolsResult } from "../../../src/daemon/protocol.js";
import type { FrameChannel } from "../../../src/daemon/transport.js";
import { ScriptedUpstreamClient, stdioPoolOptions, tool } from "../../_helpers/scripted-upstream-client.js";
import { spyLogger } from "../../_helpers/spy-logger.js";

const SOURCE = { kind: "file", path: "/home/u/bridge.json" } as const;

function channel(): FrameChannel {
  return Object.assign(new EventEmitter(), { send: () => true, close: () => {}, remote: "test" }) as unknown as FrameChannel;
}

describe("Searching an instance's tools", () => {
  let config: Record<string, unknown>;
  let clients: Map<string, ScriptedUpstreamClient>;
  let host: InstanceHost;

  async function attached(): Promise<FrameChannel> {
    const bridge = channel();
    await host.handleAttach("a", { bridgeProtocolVersion: MIN_BRIDGE_PROTOCOL_VERSION, source: SOURCE, env: {}, childEnv: {} }, bridge);
    return bridge;
  }

  function search(bridge: FrameChannel, queries: unknown[]): SearchToolsResult {
    const reply = host.handleSearchTools("s", { queries }, bridge);
    if (reply.error !== undefined) throw new Error(reply.error.message);
    return reply.result as SearchToolsResult;
  }

  const toolNames = (result: SearchToolsResult) => result.results.flatMap((r) => r.providers.flatMap((p) => p.tools.map((t) => t.tool_name)));

  async function reloadByCallingAMissingServer(next: Record<string, unknown>): Promise<void> {
    config = next;
    await host.handleCallTool("r", { callId: "reload", upstream: "not-there", name: "x" }, await attached());
  }

  beforeEach(() => {
    config = {
      mcpServers: {
        linear: { url: "https://linear.example.com/mcp", _bridge: { category: "tracker" } },
        docs: { url: "https://docs.example.com/mcp" },
      },
    };
    clients = new Map();
    host = new InstanceHost({
      idleMs: 60_000,
      logger: spyLogger(),
      onIdle: () => {},
      stdio: stdioPoolOptions(),
      loadConfig: async () => ({ config: BridgeConfigSchema.parse(config), watchPaths: [] }),
      createCredentialStore: () => ({}) as CredentialStore,
      createHttpClient: (name) => {
        const client = new ScriptedUpstreamClient(name);
        client.tools = [tool(`${name}_tool`)];
        clients.set(name, client);
        return client;
      },
    });
  });

  afterEach(async () => {
    await host.close(0);
  });

  it("answers every bridge from one index, with each server's category", async () => {
    const [first, second] = [await attached(), await attached()];

    const result = search(first, [{ provider: "", category: "track" }, { tool: "tool", expand_tools: true }]);

    expect(result.results[0]!.providers).toEqual([{ name: "linear", category: "tracker", tool_count: 1, tools: [] }]);
    expect(toolNames(result).sort()).toEqual(["docs__docs_tool", "linear__linear_tool"]);
    expect(search(second, [{ tool: "tool", expand_tools: true }])).toEqual(search(first, [{ tool: "tool", expand_tools: true }]));
  });

  it("finds a server's new tools once it reports them, keeps them while it is disconnected, and forgets them once it is removed", async () => {
    const bridge = await attached();
    const linear = clients.get("linear")!;

    linear.setTools([tool("create_issue")]);
    linear.setStatus("disconnected", new Error("reset"));
    expect(toolNames(search(bridge, [{ provider: "linear", expand_tools: true }]))).toEqual(["linear__create_issue"]);

    await reloadByCallingAMissingServer({ mcpServers: { docs: { url: "https://docs.example.com/mcp" } } });
    expect(toolNames(search(bridge, [{ provider: "linear", expand_tools: true }]))).toEqual([]);
  });

  it("follows a reload that changes a category or turns a tool off", async () => {
    const bridge = await attached();

    await reloadByCallingAMissingServer({
      mcpServers: {
        linear: { url: "https://linear.example.com/mcp", _bridge: { category: "planning", tools: { linear_tool: "never" } } },
        docs: { url: "https://docs.example.com/mcp" },
      },
    });

    expect(search(bridge, [{ category: "planning" }]).results[0]!.providers.map((p) => p.name)).toEqual(["linear"]);
    expect(search(bridge, [{ provider: "linear", expand_tools: true }]).results[0]!.providers[0]!.tools).toEqual([
      { tool_name: "linear__linear_tool", source: "linear", description: "", input_schema: {}, disabled: true },
    ]);
  });

  it("answers at once a search whose regex would backtrack without end, so other bridges keep being served", async () => {
    const bridge = await attached();
    clients.get("docs")!.setTools([{ ...tool("long"), description: "word ".repeat(9) + "!" }]);
    const startedAt = performance.now();

    const result = search(bridge, [{ tool: "regex:^(\\w+\\s?)*\\.$", expand_tools: true }]);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(toolNames(result)).toEqual([]);
  });

  it("forgets a server's category when a reload drops it", async () => {
    const bridge = await attached();

    await reloadByCallingAMissingServer({ mcpServers: { linear: { url: "https://linear.example.com/mcp" }, docs: { url: "https://docs.example.com/mcp" } } });

    expect(search(bridge, [{ category: "tracker" }]).results[0]!.providers).toEqual([]);
    expect(search(bridge, [{ provider: "linear" }]).results[0]!.providers).toEqual([{ name: "linear", tool_count: 1, tools: [] }]);
  });

  it("stops a search that runs past its time limit, saying why", async () => {
    const bridge = await attached();
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => (now += 1_000));

    let reply: ReturnType<InstanceHost["handleSearchTools"]>;
    try {
      reply = host.handleSearchTools("s", { queries: [{ tool: "regex:tool" }, { provider: "regex:docs" }] }, bridge);
    } finally {
      clock.mockRestore();
    }

    expect(reply.error).toEqual({ code: "invalid_params", message: "search took longer than 2 seconds; use simpler regexes or fewer queries" });
  });

  it("answers a search that fails unexpectedly with an error instead of failing the manager", async () => {
    const bridge = await attached();
    vi.spyOn(ToolSearchService.prototype, "search").mockImplementationOnce(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });

    expect(host.handleSearchTools("s", { queries: [{ tool: "x" }] }, bridge).error).toEqual({
      code: "upstream_error",
      message: "Maximum call stack size exceeded",
    });
  });

  it.each([
    ["no queries", [], "'queries' must be a non-empty array of query objects."],
    ["more than 64 queries", Array.from({ length: 65 }, () => ({ tool: "x" })), "at most 64 queries per search."],
    ["a query with no term", [{ tool: "x" }, { limit: 5 }], "queries[1] must have at least one of 'tool', 'provider', or 'category'."],
    ["a term over 1024 bytes", [{ category: "é".repeat(513) }], "queries[0].category is longer than 1024 bytes."],
  ])("refuses a search with %s, as a bridge does", async (_case, queries, message) => {
    const bridge = await attached();

    expect(host.handleSearchTools("s", { queries }, bridge).error).toEqual({ code: "invalid_params", message });
  });

  it("refuses a search before ATTACH and one with malformed params", async () => {
    const bridge = await attached();

    expect(host.handleSearchTools("s", { queries: [{ tool: "x" }] }, channel()).error?.code).toBe("not_attached");
    expect(host.handleSearchTools("s", { queries: "x" }, bridge).error?.code).toBe("invalid_params");
  });
});
