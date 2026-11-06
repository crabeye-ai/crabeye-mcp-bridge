import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@modelcontextprotocol/client";
import { MAX_SEARCHED_ERROR_CHARS, ToolIndex } from "../../../src/daemon/instances/tool-index.js";
import { PolicyEngine } from "../../../src/policy/index.js";
import { tool } from "../../_helpers/scripted-upstream-client.js";

const described = (name: string, description: string): Tool => ({ ...tool(name), description });

const connected = (tools: Tool[]) => ({ status: "connected" as const, tools });

function index(policy = new PolicyEngine("always", {})): ToolIndex {
  return new ToolIndex(policy);
}

const names = (idx: ToolIndex, query: Record<string, unknown>) =>
  idx.search({ queries: [{ ...query, expand_tools: true }] }).results[0]!.providers.flatMap((provider) => provider.tools.map((t) => t.tool_name));

describe("ToolIndex", () => {
  it("indexes a server's tools under its name, finding them by tool, provider and category", () => {
    const idx = index();
    idx.follow("linear", connected([described("create_issue", "Create an issue"), described("list_teams", "List teams")]));
    idx.setCategory("linear", "project-management");

    expect(names(idx, { tool: "create" })).toEqual(["linear__create_issue"]);
    expect(names(idx, { provider: "linear" })).toEqual(["linear__create_issue", "linear__list_teams"]);
    expect(idx.search({ queries: [{ category: "project" }] }).results[0]!.providers).toEqual([
      { name: "linear", category: "project-management", tool_count: 2, tools: [] },
    ]);
  });

  it("finds a server by its new category after a change, and no longer by its old one", () => {
    const idx = index();
    idx.follow("linear", connected([tool("create_issue")]));
    idx.setCategory("linear", "old");

    idx.setCategory("linear", "new");

    expect(names(idx, { category: "new" })).toEqual(["linear__create_issue"]);
    expect(names(idx, { category: "old" })).toEqual([]);
    idx.setCategory("linear", undefined);
    expect(names(idx, { category: "new" })).toEqual([]);
  });

  it("replaces a server's tools, and forgets them and its category when it is removed", () => {
    const idx = index();
    idx.follow("svc", connected([tool("old")]));
    idx.setCategory("svc", "cat");

    idx.follow("svc", connected([tool("new")]));
    expect(names(idx, { provider: "svc" })).toEqual(["svc__new"]);
    idx.remove("svc");

    expect(names(idx, { provider: "svc" })).toEqual([]);
    expect(idx.search({ queries: [{ category: "cat" }] }).results[0]!.providers).toEqual([]);
  });

  it("shows a tool whose policy is never as disabled, keeping its place in the page", () => {
    const idx = index(new PolicyEngine("always", { svc: { tools: { b: "never" } } }));
    idx.follow("svc", connected([tool("a"), tool("b"), tool("c")]));

    const [result] = idx.search({ queries: [{ provider: "svc", expand_tools: true, limit: 2 }] }).results;

    expect(result!.providers[0]!.tools).toEqual([
      { tool_name: "svc__a", source: "svc", description: "", input_schema: { type: "object" } },
      { tool_name: "svc__b", source: "svc", description: "", input_schema: {}, disabled: true },
    ]);
    expect(result).toMatchObject({ total: 3, count: 2, remaining: 1 });
  });

  it("takes a server's tools from its snapshots when they change, keeping them while it reconnects after a drop and dropping them once it fails or needs authorization", () => {
    const idx = index();
    const all = () => names(idx, { provider: "regex:." });
    idx.follow("a", connected([tool("x")]));
    idx.follow("b", connected([tool("y")]));
    idx.follow("c", connected([tool("w")]));

    idx.follow("a", connected([tool("x")]));
    idx.follow("c", connected([tool("v")]));
    expect(all()).toEqual(["a__x", "b__y", "c__v"]);
    idx.follow("b", { status: "disconnected", tools: [] });
    idx.follow("b", { status: "connecting", tools: [] });
    expect(all()).toEqual(["a__x", "b__y", "c__v"]);
    idx.follow("b", { status: "disconnected", tools: [], error: "connect ECONNREFUSED" });
    idx.follow("c", { status: "auth_required", tools: [] });
    expect(all()).toEqual(["a__x"]);
    idx.follow("b", { status: "connecting", tools: [], error: "connect ECONNREFUSED" });
    expect(all()).toEqual(["a__x"]);
    idx.follow("b", connected([tool("y")]));
    idx.follow("c", connected([tool("u")]));
    expect(all()).toEqual(["a__x", "b__y", "c__u"]);
  });

  it("keeps a server's category while its tools are out of the index", () => {
    const idx = index();
    idx.follow("linear", connected([tool("create_issue")]));
    idx.setCategory("linear", "planning");

    idx.follow("linear", { status: "disconnected", tools: [], error: "reset" });
    idx.follow("linear", connected([tool("create_issue")]));

    expect(names(idx, { category: "planning" })).toEqual(["linear__create_issue"]);
  });

  describe("a search for a server that isn't connected", () => {
    const providersFor = (idx: ToolIndex, query: Record<string, unknown>) => idx.search({ queries: [query] }).results[0]!.providers;

    it.each([
      ["starting", { status: "connecting" as const, tools: [] }, { status: "starting", message: '"linear" is starting; search again shortly.' }],
      ["not connected", { status: "disconnected" as const, tools: [], error: "connect ECONNREFUSED" }, { status: "not_connected", message: '"linear" is not connected: connect ECONNREFUSED' }],
      ["not connected while it retries after a failed attempt", { status: "connecting" as const, tools: [], error: "connect ECONNREFUSED" }, { status: "not_connected", message: '"linear" is not connected: connect ECONNREFUSED' }],
      ["starting while it reconnects after a drop", { status: "disconnected" as const, tools: [] }, { status: "starting", message: '"linear" is starting; search again shortly.' }],
      [
        "needing authorization",
        { status: "auth_required" as const, tools: [] },
        { status: "needs_authorization", message: 'Upstream server "linear" needs re-authorization. Run: crabeye-mcp-bridge auth linear (or update its configured credentials if it does not use OAuth).' },
      ],
    ])("says the server is %s, with no tools", (_name, snapshot, note) => {
      const idx = index();
      idx.setCategory("linear", "planning");
      idx.follow("linear", snapshot);

      expect(providersFor(idx, { provider: "lin" })).toEqual([{ name: "linear", category: "planning", tool_count: 0, tools: [], ...note }]);
      expect(providersFor(idx, { provider: "regex:^linear$", expand_tools: true })).toEqual([{ name: "linear", category: "planning", tool_count: 0, tools: [], ...note }]);
    });

    it("shows the tools a server reconnecting after a drop still has next to its status", () => {
      const idx = index();
      idx.follow("linear", connected([tool("create_issue")]));
      idx.follow("linear", { status: "disconnected", tools: [] });

      expect(providersFor(idx, { provider: "linear", expand_tools: true })).toEqual([
        expect.objectContaining({
          name: "linear",
          tool_count: 1,
          status: "starting",
          message: '"linear" is reconnecting; a call to its tools waits for it to be back.',
          tools: [expect.objectContaining({ tool_name: "linear__create_issue" })],
        }),
      ]);
    });

    it("leaves out a server outside the query's category, and adds nothing to a later page", () => {
      const idx = index();
      idx.setCategory("linear", "planning");
      idx.follow("linear", { status: "disconnected", tools: [], error: "reset" });
      idx.setCategory("docs", "writing");
      idx.follow("docs", { status: "disconnected", tools: [], error: "reset" });

      expect(providersFor(idx, { provider: "regex:.", category: "plan" }).map(({ name }) => name)).toEqual(["linear"]);
      expect(providersFor(idx, { provider: "regex:.", offset: 10 })).toEqual([]);
    });

    it("answers only queries whose provider filter names the server, and counts no tools for it", () => {
      const idx = index();
      idx.follow("docs", connected([tool("read")]));
      idx.follow("linear", { status: "disconnected", tools: [], error: "reset" });

      const [byProvider, byTool, byOtherProvider] = idx.search({ queries: [{ provider: "linear" }, { tool: "read" }, { provider: "docs" }] }).results;

      expect(byProvider!.providers.map(({ name, status }) => [name, status])).toEqual([["linear", "not_connected"]]);
      expect(byProvider!.total).toBe(0);
      expect(byTool!.providers.map(({ name }) => name)).toEqual(["docs"]);
      expect(byOtherProvider!.providers.map(({ name, status }) => [name, status])).toEqual([["docs", undefined]]);
    });

    it("leaves a credential out of the error before cutting it short", () => {
      const idx = index();
      idx.follow("linear", { status: "disconnected", tools: [], error: `${"x".repeat(MAX_SEARCHED_ERROR_CHARS - 30)} https://user:supersecretpassword@host` });

      const [entry] = providersFor(idx, { provider: "linear" });

      expect(entry!.message).not.toContain("supersec");
    });

    it("answers at once when a server's error is huge", () => {
      const idx = index();
      idx.follow("linear", { status: "disconnected", tools: [], error: "a-".repeat(500_000) });
      const started = performance.now();

      const [entry] = providersFor(idx, { provider: "linear" });

      expect(performance.now() - started).toBeLessThan(500);
      expect(entry!.message!.length).toBeLessThan(MAX_SEARCHED_ERROR_CHARS + 100);
    });

    it("escapes the name and the error, and caps the error", () => {
      const idx = index();
      idx.follow("li\u202enear", { status: "disconnected", tools: [], error: `bad\x1b[31m ${"x".repeat(600)}` });

      const [entry] = providersFor(idx, { provider: "li" });

      expect(entry!.message).toMatch(/^"li\\u202enear" is not connected: bad\\x1b\[31m x+ \[truncated\]$/);
      expect(entry!.message!.length).toBeLessThan(600);
    });
  });

  it("doesn't index again when a server reports the same tools", async () => {
    const idx = index();
    idx.follow("svc", connected([described("a", "first")]));
    names(idx, { provider: "svc" });
    const { default: MiniSearch } = await import("minisearch");
    const removeAll = vi.spyOn(MiniSearch.prototype, "removeAll");

    try {
      idx.follow("svc", connected([described("a", "first")]));
      names(idx, { provider: "svc" });
      idx.follow("svc", connected([described("a", "second")]));
      names(idx, { provider: "svc" });

      expect(removeAll).toHaveBeenCalledTimes(1);
    } finally {
      removeAll.mockRestore();
    }
  });

  it("indexes a burst of changes once, at the next search", async () => {
    const idx = index();
    const { default: MiniSearch } = await import("minisearch");
    const removeAll = vi.spyOn(MiniSearch.prototype, "removeAll");

    try {
      for (const name of ["a", "b", "c"]) {
        idx.follow(name, connected([tool("x")]));
        idx.setCategory(name, "cat");
      }
      idx.remove("b");
      expect(removeAll).not.toHaveBeenCalled();

      expect(names(idx, { category: "cat" })).toEqual(["a__x", "c__x"]);
      expect(removeAll).toHaveBeenCalledTimes(1);
    } finally {
      removeAll.mockRestore();
    }
  });

  it("searches through words that each extend the last without running out of stack", () => {
    const idx = index();
    const words = Array.from({ length: 2_500 }, (_, i) => `search${"h".repeat(i + 1)}`);
    const tools: Tool[] = [];
    for (let i = 0; i < words.length; i += 10) tools.push(described(`t${i}`, words.slice(i, i + 10).join(" ")));
    idx.follow("svc", connected(tools));

    expect(names(idx, { tool: "search" })).not.toEqual([]);
  });

  it("finds a tool by a name longer than the words it indexes", () => {
    const idx = index();
    const long = "getAllRepositoryCollaboratorsWithPermissionsAndInvitationsForOrganization";
    idx.follow("svc", connected([tool(long), tool("other")]));

    expect(names(idx, { tool: long })).toEqual([`svc__${long}`]);
  });

  it("leaves a tool whose name is too long to call out of search", () => {
    const idx = index();
    idx.follow("svc", connected([tool("a".repeat(1_024)), tool("b".repeat(1_025))]));

    expect(names(idx, { provider: "svc" })).toEqual([`svc__${"a".repeat(1_024)}`]);
  });

  it("searches only the start of a huge description, showing all of it", () => {
    const idx = index();
    const description = `${"word ".repeat(4_000)}needle`;
    idx.follow("svc", connected([described("big", description)]));

    expect(names(idx, { tool: "regex:needle" })).toEqual([]);
    expect(names(idx, { tool: "needle" })).toEqual([]);
    expect(names(idx, { tool: "regex:word" })).toEqual(["svc__big"]);
    expect(idx.search({ queries: [{ tool: "word", expand_tools: true }] }).results[0]!.providers[0]!.tools[0]!.description).toBe(description);
  });
});
