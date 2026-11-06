import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import type { SearchToolsResponse } from "../../src/search/index.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { callStubToolResult, scratchHome, type BridgeProcess, type ScratchHome } from "../_helpers/bridge-process.js";
import { startProtectedUpstream, type ProtectedUpstream } from "../_helpers/protected-upstream.js";
import { STUB_STARTUP_ERROR_ENV } from "../_helpers/stub-stdio-server.js";
import { LIST_CHANGE_INTERVAL_MS } from "../../src/server/list-change-announcer.js";

const isWindows = process.platform === "win32";
const HEADER = "Servers (search by provider name):";
const LOCKED = "- locked: needs authorization; the user runs: crabeye-mcp-bridge auth locked, or updates its credentials if it doesn't use OAuth";

describe.skipIf(isWindows)("the servers the built CLI lists in the search_tools description", { timeout: 60_000 }, () => {
  let cliScript: string;
  let home: ScratchHome | undefined;
  let upstream: ProtectedUpstream | undefined;

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-server-list");
  });

  afterEach(async () => {
    await home?.cleanUp();
    home = undefined;
    await upstream?.close();
    upstream = undefined;
  }, 30_000);

  async function workspace(): Promise<ScratchHome> {
    home = await scratchHome(() => [cliScript], { stubBridge: { category: "tools" } });
    upstream = await startProtectedUpstream("ok");
    const stub = join(home.dir, "stub.cjs");
    const late = join(home.dir, "late.cjs");
    await writeFile(late, `setTimeout(() => require(${JSON.stringify(stub)}), 3000);`);
    await writeFile(
      home.configPath,
      JSON.stringify({
        mcpServers: {
          stub: { command: process.execPath, args: [stub], _bridge: { category: "tools" } },
          late: { command: process.execPath, args: [late] },
          broken: { command: process.execPath, args: [stub], env: { [STUB_STARTUP_ERROR_ENV]: "boom: cannot start" } },
          locked: { type: "streamable-http", url: upstream.url, _bridge: { auth: { type: "oauth2" } } },
        },
      }),
    );
    return home;
  }

  const listChanges = (bridge: BridgeProcess) => bridge.notifications().filter((method) => method === "notifications/tools/list_changed").length;

  async function searchDescription(bridge: BridgeProcess): Promise<string> {
    return (await bridge.client.listTools()).tools.find((tool) => tool.name === "search_tools")!.description!;
  }

  /** Fetches the description after each announced change until it is `expected`. */
  async function announcedUntil(bridge: BridgeProcess, expected: string): Promise<void> {
    let seen = 0;
    let latest = "";
    try {
      await until(async () => {
        if (listChanges(bridge) === seen) return false;
        seen = listChanges(bridge);
        latest = await searchDescription(bridge);
        return latest.endsWith(`\n\n${expected}`);
      }, 20_000);
    } catch (err) {
      throw new Error(`the description never became the one expected; last fetched: ${JSON.stringify(latest)}`, { cause: err });
    }
  }

  async function providerSearch(bridge: BridgeProcess, provider: string) {
    const result = await bridge.client.callTool({ name: "search_tools", arguments: { queries: [{ provider }] } });
    return (JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as SearchToolsResponse).results[0]!.providers;
  }

  it.each([false, true])("lists every server with its status, announces each change, and says in a search why one isn't connected (modern: %s)", async (modern) => {
    const scratch = await workspace();
    const bridge = await scratch.connectBridge(cliScript, { modern });
    const subscription = modern ? await bridge.client.listen({ toolsListChanged: true }) : undefined;

    expect(await searchDescription(bridge)).toMatch(/\n- stub[^\n]*\n- late: starting\n- broken[^\n]*\n- locked[^\n]*$/);
    await announcedUntil(bridge, [HEADER, "- stub [tools]", "- late", "- broken: not connected", LOCKED].join("\n"));

    expect(await providerSearch(bridge, "broken")).toEqual([
      { name: "broken", tool_count: 0, tools: [], status: "not_connected", message: '"broken" is not connected: Connection closed' },
    ]);
    expect(await providerSearch(bridge, "locked")).toEqual([
      {
        name: "locked",
        tool_count: 0,
        tools: [],
        status: "needs_authorization",
        message: 'Upstream server "locked" needs re-authorization. Run: crabeye-mcp-bridge auth locked (or update its configured credentials if it does not use OAuth).',
      },
    ]);

    await rm(join(scratch.dir, "stub.cjs"));
    await callStubToolResult(bridge, "crash", { lines: ["Error: gone"], code: 1 });
    await announcedUntil(bridge, [HEADER, "- stub [tools]: not connected", "- late", "- broken: not connected", LOCKED].join("\n"));
    expect(await providerSearch(bridge, "stub")).toEqual([
      expect.objectContaining({ name: "stub", category: "tools", tool_count: 0, tools: [], status: "not_connected" }),
    ]);
    expect((await bridge.client.listTools()).tools.map(({ name }) => name)).toEqual(["search_tools", "run_tool"]);
    await subscription?.close();
  });

  it("settles on the same list once the manager is restarted, announcing nothing more", async () => {
    const scratch = await scratchHome(() => [cliScript], { stubBridge: { category: "tools" } });
    home = scratch;
    const bridge = await scratch.connectBridge(cliScript);
    const listed = `${HEADER}\n- stub [tools]`;
    await announcedUntil(bridge, listed);
    const before = (await scratch.status())!.pid;
    const heardBefore = listChanges(bridge);

    await promisify(execFile)(process.execPath, [cliScript, "daemon", "restart"], { env: scratch.env() });
    await until(async () => {
      const status = await scratch.status();
      return status !== null && status.pid !== before && status.instances[0]?.bridges === 1 && status.upstreams[0]?.status === "connected";
    }, 20_000);
    await new Promise((resolve) => setTimeout(resolve, LIST_CHANGE_INTERVAL_MS + 500));
    if (listChanges(bridge) > heardBefore) await announcedUntil(bridge, listed);
    const heard = listChanges(bridge);
    await new Promise((resolve) => setTimeout(resolve, LIST_CHANGE_INTERVAL_MS * 2));

    expect(listChanges(bridge)).toBe(heard);
    expect((await searchDescription(bridge)).endsWith(`\n\n${listed}`)).toBe(true);
  });
});
