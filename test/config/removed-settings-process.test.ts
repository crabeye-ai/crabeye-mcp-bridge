import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { STUB_STDIO_SERVER } from "../_helpers/stub-stdio-server.js";
import { CALLED, callStubTool, connectBridgeProcess, occurrences, stopDaemonsOf, type BridgeProcess } from "../_helpers/bridge-process.js";

const isWindows = process.platform === "win32";

function warning(setting: string, location: string): string {
  return `${setting} no longer has any effect and is ignored (${location}); every bridge shares one process per STDIO server`;
}

describe.skipIf(isWindows)("bridge process with removed sharing settings in its config", { timeout: 60_000 }, () => {
  let cliScript: string;
  let dir: string;
  let bridge: BridgeProcess | undefined;

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-removed-settings");
  });

  afterEach(async () => {
    await bridge?.client.close().catch(() => {});
    bridge = undefined;
    await stopDaemonsOf([cliScript]);
    await rm(dir, { recursive: true, force: true });
  }, 20_000);

  it("starts, warns once per removed setting, serves the server, and warns about one a reload adds", async () => {
    dir = await mkdtemp("/tmp/cbe-removed-");
    const stub = join(dir, "stub.cjs");
    await writeFile(stub, STUB_STDIO_SERVER);
    const configPath = join(dir, "client.json");
    const config = (daemon: Record<string, unknown>) =>
      JSON.stringify({
        mcpServers: { stub: { command: process.execPath, args: [stub], _bridge: { sharing: "dedicated" } } },
        _bridge: { daemon },
      });
    await writeFile(configPath, config({ autoForkDrainTimeoutMs: 1_000 }));
    bridge = await connectBridgeProcess(cliScript, configPath, { ...process.env, HOME: dir });
    const { stderr } = bridge;

    expect(await callStubTool(bridge)).toEqual(CALLED);
    expect(occurrences(stderr(), warning("sharing", 'server "stub"'))).toBe(1);
    expect(occurrences(stderr(), warning("daemon.autoForkDrainTimeoutMs", "_bridge"))).toBe(1);

    await writeFile(configPath, config({ autoForkDrainTimeoutMs: 1_000, autoForkInitializeTimeoutMs: 5 }));
    const added = warning("daemon.autoForkInitializeTimeoutMs", "_bridge");
    await until(() => stderr().includes(added), 10_000);

    expect(occurrences(stderr(), added)).toBe(1);
  });
});
