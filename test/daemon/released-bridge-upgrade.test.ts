import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { daemonPidsRunning } from "../_helpers/processes.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { CALLED, STILL_RUNNING, callStubTool, callStubToolResult, cliAtVersion, scratchHome, type ScratchHome } from "../_helpers/bridge-process.js";
import { errorResult } from "../_helpers/run-tool.js";
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

  it("replaces the 1.3.0 daemon, and a 1.3.0 bridge attached to it moves to the new one", async () => {
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
    await until(async () => (await home.status())?.sessions.length === 2, 20_000);
    expect(await callStubTool(releasedBridge)).toEqual(CALLED);
    expect(await home.status()).toMatchObject({ pid: replaced!.pid, appVersion: APP_VERSION });
    await until(() => daemonPidsRunning(releasedScript).length === 0, 10_000);
    expect(newBridge.stderr()).not.toContain(STILL_RUNNING);
  });

  it("lets a 1.3.0 bridge started after the upgrade use the new daemon, sharing its child, and keeps serving it through that child's stderr and crash", async () => {
    const releasedScript = await workspace();
    const newBridge = await home.connectBridge(cliScript);
    expect(await callStubTool(newBridge)).toEqual(CALLED);
    const running = await home.status();

    const releasedBridge = await home.connectBridge(releasedScript);

    expect(await callStubTool(releasedBridge)).toEqual(CALLED);
    const shared = await home.status();
    expect(shared).toMatchObject({ pid: running!.pid, appVersion: APP_VERSION });
    expect(shared!.children).toEqual([expect.objectContaining({ refcount: 2 })]);

    await callStubTool(newBridge, "stderr", { text: "seen by current bridges only" });
    expect(await callStubTool(releasedBridge)).toEqual(CALLED);
    expect(await callStubToolResult(newBridge, "crash", { lines: ["Error: upstream gone"], code: 1 })).toMatchObject(
      errorResult('Upstream server "stub" error: child process exited'),
    );
    await until(async () => isDeepStrictEqual(await callStubTool(releasedBridge).catch(() => null), CALLED), 20_000);
  });

  it("keeps the 1.3.0 daemon a pre-release bridge leaves running, and serves that bridge's calls through it", async () => {
    const releasedScript = await workspace();
    const preReleaseScript = await cliAtVersion(cliScript, home.dir, "99.0.0-beta.1");
    releasedScripts.push(preReleaseScript);
    execFileSync(process.execPath, [releasedScript, "daemon", "start"], { env: home.env(), stdio: "ignore" });
    const old = await home.status();
    expect(old!.appVersion).toBeUndefined();

    const preReleaseBridge = await home.connectBridge(preReleaseScript);

    expect(await callStubTool(preReleaseBridge)).toEqual(CALLED);
    const kept = await home.status();
    expect(kept).toMatchObject({ pid: old!.pid });
    expect(kept!.appVersion).toBeUndefined();
    expect(kept!.sessions).toHaveLength(1);
  });
});
