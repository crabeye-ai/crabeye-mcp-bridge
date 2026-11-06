import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual, promisify } from "node:util";
import { ProtocolErrorCode } from "@modelcontextprotocol/client";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { CALLED, callStubTool, callStubToolResult, occurrences, scratchHome, type BridgeLaunch, type BridgeProcess, type ScratchHome } from "../_helpers/bridge-process.js";
import { errorResult } from "../_helpers/run-tool.js";
import { runToolDefinition, searchToolDefinition } from "../../src/search/index.js";
import { LIST_CHANGE_INTERVAL_MS } from "../../src/server/list-change-announcer.js";

const isWindows = process.platform === "win32";
const DISCOVERY_MODE_WARNING = "WARN  [config] --discovery-mode no longer has any effect and is ignored; the bridge only exposes search_tools and run_tool";

describe.skipIf(isWindows)("the bridge's tool list from the built CLI", { timeout: 60_000 }, () => {
  let cliScript: string;
  let home: ScratchHome | undefined;

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-fixed-tools");
  });

  afterEach(async () => {
    await home?.cleanUp();
    home = undefined;
  }, 30_000);

  async function scratch(): Promise<ScratchHome> {
    home ??= await scratchHome(() => [cliScript]);
    return home;
  }

  async function bridge(launch: BridgeLaunch = {}): Promise<BridgeProcess> {
    const connected = await (await scratch()).connectBridge(cliScript, launch);
    expect(await callStubTool(connected)).toEqual(CALLED);
    return connected;
  }

  async function search(connected: BridgeProcess, query: Record<string, unknown>): Promise<string> {
    const result = await connected.client.callTool({ name: "search_tools", arguments: { queries: [query] } });
    return (result.content as Array<{ text: string }>)[0]!.text;
  }

  async function toolList(connected: BridgeProcess) {
    return (await connected.client.listTools()).tools;
  }

  async function addSecondServer(connected: BridgeProcess): Promise<void> {
    await until(() => connected.stderr().includes("ready —"), 10_000);
    const { configPath } = await scratch();
    const config = JSON.parse(await readFile(configPath, "utf-8")) as { mcpServers: Record<string, unknown> };
    config.mcpServers.second = config.mcpServers.stub;
    await writeFile(configPath, JSON.stringify(config));
    await until(async () => (await search(connected, { provider: "second", expand_tools: true })).includes("second__plain"), 10_000);
  }

  async function searchDescription(connected: BridgeProcess): Promise<string | undefined> {
    return (await toolList(connected)).find((tool) => tool.name === "search_tools")?.description;
  }

  const listChanges = (connected: BridgeProcess) => connected.notifications().filter((method) => method === "notifications/tools/list_changed").length;

  async function settled(connected: BridgeProcess): Promise<void> {
    await until(async () => (await searchDescription(connected))?.endsWith("\n- stub") === true, 10_000);
    await new Promise((resolve) => setTimeout(resolve, LIST_CHANGE_INTERVAL_MS + 500));
  }

  it.each([false, true])("keeps search_tools and run_tool as its only tools, announcing no change for searches or an upstream's new tool (modern: %s)", async (modern) => {
    const connected = await bridge({ modern });
    expect(connected.client.getProtocolEra()).toBe(modern ? "modern" : "legacy");
    expect(connected.client.getServerCapabilities()?.tools).toEqual({ listChanged: true });
    const subscription = modern ? await connected.client.listen({ toolsListChanged: true }) : undefined;
    expect(subscription?.honoredFilter).toEqual(modern ? { toolsListChanged: true } : undefined);
    await settled(connected);
    const before = listChanges(connected);

    await search(connected, { tool: "plain" });
    await search(connected, { provider: "stub", expand_tools: true });
    await callStubTool(connected, "add-tool", { name: "freshly-added" });
    await until(async () => (await search(connected, { tool: "freshly-added" })).includes("stub__freshly-added"), 10_000);
    await new Promise((resolve) => setTimeout(resolve, LIST_CHANGE_INTERVAL_MS + 500));

    expect(listChanges(connected)).toBe(before);
    expect((await toolList(connected)).map(({ name }) => name)).toEqual([searchToolDefinition.name, runToolDefinition.name]);
    await subscription?.close();
  });

  it.each([false, true])("keeps the same two tools through a crash, and announces a server a reload adds (modern: %s)", async (modern) => {
    const connected = await bridge({ modern });
    const subscription = modern ? await connected.client.listen({ toolsListChanged: true }) : undefined;

    expect(await callStubToolResult(connected, "crash", { lines: ["Error: gone"], code: 1 })).toMatchObject(
      errorResult('Upstream server "stub" error: child process exited'),
    );
    await until(async () => isDeepStrictEqual(await callStubTool(connected).catch(() => null), CALLED), 10_000);
    expect(connected.stderr()).toContain("STDIO server exited with code 1");
    await settled(connected);
    const afterCrash = listChanges(connected);
    await addSecondServer(connected);
    await until(() => listChanges(connected) > afterCrash, 10_000);
    expect(await searchDescription(connected)).toMatch(/\n- stub\n- second$/);

    expect((await toolList(connected)).map(({ name }) => name)).toEqual([searchToolDefinition.name, runToolDefinition.name]);
    await subscription?.close();
  });

  it("refuses a direct call of an upstream tool as an unknown tool, while run_tool still runs it", async () => {
    const connected = await bridge();

    await expect(connected.client.callTool({ name: "stub__plain", arguments: {} })).rejects.toMatchObject({
      code: ProtocolErrorCode.InvalidParams,
      message: "Tool stub__plain not found",
    });
    expect(await callStubTool(connected)).toEqual(CALLED);
  });

  it.each([false, true])("returns a policy denial and refused arguments as error results the assistant can read (modern: %s)", async (modern) => {
    home = await scratchHome(() => [cliScript], { stubBridge: { tools: { "log-message": "never" } } });
    const connected = await bridge({ modern });

    expect(await callStubToolResult(connected, "log-message")).toMatchObject(errorResult("Tool stub__log-message is disabled by policy"));
    expect(await connected.client.callTool({ name: "run_tool", arguments: {} })).toMatchObject(
      errorResult("Input validation error: Invalid arguments for tool run_tool: data must have required property 'name'"),
    );
  });

  it.each(["search", "tools_list", "both"])("starts with --discovery-mode %s, warns once, and behaves as without it", async (mode) => {
    const withFlag = await bridge({ extraArgs: ["--discovery-mode", mode] });
    const without = await bridge();

    expect(occurrences(withFlag.stderr(), DISCOVERY_MODE_WARNING)).toBe(1);
    expect(without.stderr()).not.toContain(DISCOVERY_MODE_WARNING);
    expect(await toolList(withFlag)).toEqual(await toolList(without));
    const query = { provider: "stub", expand_tools: true };
    expect(await search(withFlag, query)).toEqual(await search(without, query));
    expect(await search(withFlag, query)).toContain('"input_schema":{"type":"object"}');
  });

  it("warns about --discovery-mode once, not again when the config reloads", async () => {
    const connected = await bridge({ extraArgs: ["--discovery-mode", "tools_list"] });

    await addSecondServer(connected);

    expect(occurrences(connected.stderr(), DISCOVERY_MODE_WARNING)).toBe(1);
  });

  it("still refuses a --discovery-mode value that was never valid", async () => {
    await expect(promisify(execFile)(process.execPath, [cliScript, "--discovery-mode", "bogus", "--validate"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Allowed choices are search, tools_list, both"),
    });
  });

  it("leaves --discovery-mode out of --help", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [cliScript, "--help"]);

    expect(stdout).toContain("--config");
    expect(stdout).not.toContain("discovery");
  });
});
