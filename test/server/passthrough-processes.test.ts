import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderResult, SearchQuery, SearchToolsResponse } from "../../src/search/index.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { scratchHome, type BridgeProcess, type ScratchHome } from "../_helpers/bridge-process.js";
import { STUB_INSTRUCTIONS_ENV } from "../_helpers/stub-stdio-server.js";

const isWindows = process.platform === "win32";
const GUIDE = "Use cwd to find the working folder.";

type Shown = Pick<ProviderResult, "name" | "status" | "instructions" | "has_instructions">;

describe.skipIf(isWindows)("a server's instructions in the built CLI's search results", { timeout: 60_000 }, () => {
  let cliScript: string;
  let home: ScratchHome | undefined;

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-passthrough");
  });

  afterEach(async () => {
    await home?.cleanUp();
    home = undefined;
  }, 30_000);

  async function writeConfig(scratch: ScratchHome, passthrough: boolean): Promise<void> {
    const stub = { command: process.execPath, args: [join(scratch.dir, "stub.cjs")], env: { [STUB_INSTRUCTIONS_ENV]: GUIDE } };
    await writeFile(scratch.configPath, JSON.stringify({ mcpServers: { guide: { ...stub, _bridge: { passthrough } }, plain: stub } }));
  }

  async function search(bridge: BridgeProcess, ...queries: SearchQuery[]): Promise<Shown[][]> {
    const result = await bridge.client.callTool({ name: "search_tools", arguments: { queries } });
    return (JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as SearchToolsResponse).results.map((query) =>
      query.providers.map(({ name, status, instructions, has_instructions }) => ({ name, status, instructions, has_instructions })),
    );
  }

  it.each([false, true])("marks a passthrough server's instructions, returns them when a query asks, and stops once passthrough is turned off (modern: %s)", async (modern) => {
    const scratch = await scratchHome(() => [cliScript]);
    home = scratch;
    await writeConfig(scratch, true);
    const bridge = await scratch.connectBridge(cliScript, { modern });
    await until(async () => {
      const [byTool, byGuide] = await search(bridge, { tool: "cwd" }, { provider: "guide" });
      return byTool!.length === 2 && byGuide![0]?.has_instructions === true;
    }, 20_000);

    expect(await search(bridge, { provider: "guide" }, { provider: "plain" })).toEqual([
      [{ name: "guide", has_instructions: true }],
      [{ name: "plain" }],
    ]);
    const [byGuide, byPlain, byTool] = await search(
      bridge,
      { provider: "guide", include_instructions: true },
      { provider: "plain", include_instructions: true },
      { tool: "cwd", include_instructions: true },
    );
    expect([byGuide, byPlain]).toEqual([[{ name: "guide", instructions: GUIDE }], [{ name: "plain" }]]);
    expect([...byTool!].sort((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: "guide" }, { name: "plain" }]);

    await writeConfig(scratch, false);
    await until(async () => (await search(bridge, { provider: "guide", include_instructions: true }))[0]![0]?.instructions === undefined, 20_000);
    expect(await search(bridge, { provider: "guide" }, { provider: "guide", include_instructions: true })).toEqual([[{ name: "guide" }], [{ name: "guide" }]]);
  });
});
