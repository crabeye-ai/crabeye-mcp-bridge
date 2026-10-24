import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR } from "../../src/constants.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { CALLED, callStubTool, scratchHome, type BridgeProcess, type ScratchHome } from "../_helpers/bridge-process.js";
import { MODERN_STUB_DISCOVER_LOG_ENV, MODERN_STUB_START_DELAY_ENV, STUB_IGNORE_DISCOVER_ENV } from "../_helpers/stub-stdio-server.js";
import { viaRunTool } from "../_helpers/run-tool.js";

const isWindows = process.platform === "win32";
const PROBE_TIMEOUT_MS = 10_000;
const ECHOED = [{ type: "text", text: "echoed" }];

describe.skipIf(isWindows)("protocol era of shared STDIO servers over the built CLI", { timeout: 90_000 }, () => {
  let cliScript: string;
  let modernServer: string;
  let home: ScratchHome | undefined;

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-era");
    modernServer = await bundleForSubprocess("test/_helpers/subprocess/modern-stdio-server.ts", "modern-stdio-server");
  });

  afterEach(async () => {
    await home?.cleanUp();
    home = undefined;
  }, 30_000);

  async function modernHome(
    daemon: Record<string, unknown> = {},
    serverEnv: Record<string, string> = {},
  ): Promise<{ discovers: () => Promise<string[]> }> {
    home = await scratchHome(() => [cliScript], { bridge: { healthCheckInterval: 1 } });
    await writeFile(join(home.dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: 0, ...daemon } } }));
    const log = join(home.dir, "discovers.log");
    await writeFile(log, "");
    const config = JSON.parse(await readFile(home.configPath, "utf-8")) as { mcpServers: Record<string, unknown> };
    config.mcpServers = { modern: { command: process.execPath, args: [modernServer], env: { [MODERN_STUB_DISCOVER_LOG_ENV]: log, ...serverEnv } } };
    await writeFile(home.configPath, JSON.stringify(config));
    return { discovers: async () => (await readFile(log, "utf-8")).split("\n").filter(Boolean) };
  }

  const upstreamEras = (bridge: BridgeProcess, server: string) =>
    [...bridge.stderr().matchAll(new RegExp(`\\[upstream:${server}\\] connected era=(\\w+)`, "g"))].map((match) => match[1]);
  const echo = async (bridge: BridgeProcess) => (await bridge.client.callTool(viaRunTool("modern__echo"))).content;
  const eras = async () => (await home!.status())!.children.map(({ serverName, era }) => ({ serverName, era }));

  it("probes a modern server shared by two bridges once, answering later probes and health checks from the daemon", async () => {
    const { discovers } = await modernHome();
    const first = await home!.connectBridge(cliScript);
    expect(await echo(first)).toEqual(ECHOED);
    const second = await home!.connectBridge(cliScript, { modern: true });
    expect(await echo(second)).toEqual(ECHOED);

    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(await discovers()).toHaveLength(1);
    expect(upstreamEras(first, "modern")).toEqual(["modern"]);
    expect(upstreamEras(second, "modern")).toEqual(["modern"]);
    expect(await eras()).toEqual([{ serverName: "modern", era: "modern" }]);
  });

  it("lets health checks reach a modern server when the daemon's child ping is off", async () => {
    const { discovers } = await modernHome({ childPingMs: 0 });
    const bridge = await home!.connectBridge(cliScript);
    expect(await echo(bridge)).toEqual(ECHOED);

    await until(async () => (await discovers()).length >= 3, 10_000);
  });

  it("delivers a modern server's tool-list change to every bridge using it", async () => {
    await modernHome();
    const first = await home!.connectBridge(cliScript);
    expect(await echo(first)).toEqual(ECHOED);
    const second = await home!.connectBridge(cliScript);
    expect(await echo(second)).toEqual(ECHOED);

    await first.client.callTool(viaRunTool("modern__add-tool"));

    const finds = async (bridge: BridgeProcess) => {
      const result = await bridge.client.callTool({ name: "search_tools", arguments: { queries: [{ tool: "added" }] } });
      return (result.content as Array<{ text: string }>)[0]!.text.includes("modern__added");
    };
    await until(() => finds(first), 10_000);
    await until(() => finds(second), 10_000);
  });

  it("probes a restarted modern server again", async () => {
    const { discovers } = await modernHome();
    const bridge = await home!.connectBridge(cliScript);
    expect(await echo(bridge)).toEqual(ECHOED);
    const [firstChild] = await discovers();

    await bridge.client.callTool(viaRunTool("modern__exit"));
    await until(async () => (await discovers()).some((pid) => pid !== firstChild), 20_000);
    await until(async () => isDeepStrictEqual(await echo(bridge).catch(() => null), ECHOED), 20_000);

    expect(new Set(await discovers()).size).toBe(2);
    expect(await eras()).toEqual([{ serverName: "modern", era: "modern" }]);
  });

  it("serves later bridges at once from a modern server that started too slowly for the first bridge's check", async () => {
    await modernHome({}, { [MODERN_STUB_START_DELAY_ENV]: String(PROBE_TIMEOUT_MS + 1_000) });
    const first = await home!.connectBridge(cliScript);
    await until(async () => isDeepStrictEqual(await echo(first).catch(() => null), ECHOED), 30_000);
    expect(upstreamEras(first, "modern")).toEqual(["legacy"]);

    const secondStarted = Date.now();
    const second = await home!.connectBridge(cliScript);
    await until(async () => isDeepStrictEqual(await echo(second).catch(() => null), ECHOED), 10_000);

    expect(Date.now() - secondStarted).toBeLessThan(PROBE_TIMEOUT_MS / 2);
    expect(upstreamEras(second, "modern")).toEqual(["legacy"]);
    expect(await eras()).toEqual([{ serverName: "modern", era: "legacy" }]);
  });

  it("makes only the first bridge wait for a legacy server that ignores the probe", async () => {
    home = await scratchHome(() => [cliScript], { stubEnv: { [STUB_IGNORE_DISCOVER_ENV]: "1" } });

    const firstStarted = Date.now();
    const first = await home.connectBridge(cliScript);
    expect(await callStubTool(first)).toEqual(CALLED);
    const firstTook = Date.now() - firstStarted;

    const secondStarted = Date.now();
    const second = await home.connectBridge(cliScript);
    expect(await callStubTool(second)).toEqual(CALLED);
    const secondTook = Date.now() - secondStarted;

    expect(firstTook).toBeGreaterThanOrEqual(PROBE_TIMEOUT_MS);
    expect(secondTook).toBeLessThan(PROBE_TIMEOUT_MS / 2);
    expect(upstreamEras(second, "stub")).toEqual(["legacy"]);
    expect(await eras()).toEqual([{ serverName: "stub", era: "legacy" }]);
  });
});
