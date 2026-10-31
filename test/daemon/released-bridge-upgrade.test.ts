import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { daemonPidsRunning } from "../_helpers/processes.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { CALLED, STILL_RUNNING, callStubTool, cliAtVersion, scratchHome, type BridgeProcess, type ScratchHome } from "../_helpers/bridge-process.js";
import { installReleasedBridge, releasedBridgeAt } from "../_helpers/released-bridge.js";
import { processExists } from "../../src/process/process-utils.js";
import { APP_VERSION } from "../../src/constants.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("upgrading from the released crabeye 1.3.0", { timeout: 60_000 }, () => {
  let cliScript: string;
  let releasedScripts: string[];
  let home: ScratchHome;

  beforeAll(async () => {
    [cliScript] = await Promise.all([bundleForSubprocess("src/index.ts", "cli-released-upgrade"), installReleasedBridge("1.3.0")]);
  }, 180_000);

  afterEach(async () => {
    await home.cleanUp();
  }, 30_000);

  async function workspace(): Promise<string> {
    releasedScripts = [];
    home = await scratchHome(() => [cliScript, ...releasedScripts], { bridge: { daemon: { respawnLockWaitMs: 1_000 } } });
    const releasedScript = await releasedBridgeAt("1.3.0", join(home.dir, "crabeye-1.3.0"));
    releasedScripts.push(releasedScript);
    return releasedScript;
  }

  const RESTART_REFUSAL = "restart the AI client";

  const toldToRestart = (bridge: BridgeProcess) => until(() => bridge.stderr().includes(RESTART_REFUSAL), 30_000);

  it("replaces the 1.3.0 daemon, and a 1.3.0 bridge attached to it fails its STDIO calls without disturbing the new one", async () => {
    const releasedScript = await workspace();
    execFileSync(process.execPath, [releasedScript, "daemon", "start"], { env: home.env(), stdio: "ignore" });
    const old = await home.status();
    expect(old).not.toBeNull();
    expect(old!.appVersion).toBeUndefined();
    const releasedBridge = await home.connectBridge(releasedScript);
    expect(await callStubTool(releasedBridge)).toEqual(CALLED);

    const newBridge = await home.connectBridge(cliScript);

    expect(await callStubTool(newBridge)).toEqual(CALLED);
    const replaced = await home.status();
    expect(replaced).toMatchObject({ appVersion: APP_VERSION });
    expect(processExists(old!.pid)).toBe(false);
    await until(async () => !(await callStubTool(releasedBridge).then(() => true, () => false)), 30_000);
    expect(await callStubTool(newBridge)).toEqual(CALLED);
    expect(await home.status()).toMatchObject({ pid: replaced!.pid, appVersion: APP_VERSION });
    await until(() => daemonPidsRunning(releasedScript).length === 0, 10_000);
    expect(newBridge.stderr()).not.toContain(STILL_RUNNING);
  });

  it("tells a 1.3.0 bridge started next to a current one to restart its AI client, leaving the manager and the current bridge alone", async () => {
    const releasedScript = await workspace();
    const newBridge = await home.connectBridge(cliScript);
    expect(await callStubTool(newBridge)).toEqual(CALLED);
    const running = await home.status();

    const releasedBridge = await home.connectBridge(releasedScript);

    await toldToRestart(releasedBridge);
    for (let i = 0; i < 3; i++) {
      expect(await callStubTool(newBridge)).toEqual(CALLED);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(await home.status()).toMatchObject({ pid: running!.pid, appVersion: APP_VERSION });
    expect(daemonPidsRunning(releasedScript)).toEqual([]);
  });

  it("replaces the 1.3.0 daemon for a pre-release bridge too, since its protocol is too old for that bridge", async () => {
    const releasedScript = await workspace();
    const preReleaseScript = await cliAtVersion(cliScript, home.dir, "99.0.0-beta.1");
    releasedScripts.push(preReleaseScript);
    execFileSync(process.execPath, [releasedScript, "daemon", "start"], { env: home.env(), stdio: "ignore" });
    const old = await home.status();
    expect(old!.appVersion).toBeUndefined();

    const preReleaseBridge = await home.connectBridge(preReleaseScript);

    expect(await callStubTool(preReleaseBridge)).toEqual(CALLED);
    const replaced = await home.status();
    expect(replaced).toMatchObject({ appVersion: "99.0.0-beta.1" });
    expect(processExists(old!.pid)).toBe(false);
    expect(replaced!.children).toHaveLength(1);
  });
});
