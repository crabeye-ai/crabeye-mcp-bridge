import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { daemonPidsRunning } from "../_helpers/processes.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { CALLED, STILL_RUNNING, callStubTool, callStubToolResult, cliAtVersion, occurrences, scratchHome, type ScratchHome } from "../_helpers/bridge-process.js";
import { errorResult } from "../_helpers/run-tool.js";
import { PROTOCOL_VERSION, type StatusResult } from "../../src/daemon/protocol.js";
import { DAEMON_LAUNCH_ARGS } from "../../src/daemon/daemon-identity.js";
import { AWAIT_PREDECESSOR_FLAG, successorReport } from "../../src/daemon/daemon-launch.js";
import { processExists } from "../../src/process/process-utils.js";
import { daemonFilesFor } from "../../src/daemon/paths.js";
import { APP_NAME, APP_VERSION } from "../../src/constants.js";

const isWindows = process.platform === "win32";
const STILL_RUNNING_WARNING = `a daemon from an older ${APP_NAME} version (unknown) ${STILL_RUNNING}; this bridge (${APP_VERSION}) will use it`;

describe.skipIf(isWindows)("bridges and daemons from different crabeye versions", { timeout: 60_000 }, () => {
  let cliScript: string;
  let olderDaemonScript: string;
  let home: ScratchHome;
  const scripts = new Set<string>();

  beforeAll(async () => {
    [cliScript, olderDaemonScript] = await Promise.all([
      bundleForSubprocess("src/index.ts", "cli-outdated"),
      bundleForSubprocess("test/_helpers/subprocess/older-daemon.ts", "older-daemon"),
    ]);
  });

  afterEach(async () => {
    await home.cleanUp();
    scripts.clear();
  }, 30_000);

  async function workspace(stubBridge: Record<string, unknown> = {}): Promise<void> {
    home = await scratchHome(() => [...scripts], { stubBridge });
  }

  const cliAt = (version: string) => cliAtVersion(cliScript, home.dir, version);
  const daemonLogPath = () => join(home.dir, ".crabeye", "logs", "daemon.log");

  async function startDaemon(script: string): Promise<StatusResult> {
    scripts.add(script);
    execFileSync(process.execPath, [script, "daemon", "start"], { env: home.env(), stdio: "ignore" });
    const running = await home.status();
    expect(running).not.toBeNull();
    return running!;
  }

  async function startOlderDaemon(...flags: string[]): Promise<{ pid: number; requests: (method: string) => Promise<string[]> }> {
    scripts.add(olderDaemonScript);
    const requestLog = join(home.dir, "older-daemon-requests.log");
    await writeFile(requestLog, "");
    const daemon = spawn(process.execPath, [olderDaemonScript, ...DAEMON_LAUNCH_ARGS, "--request-log", requestLog, ...flags], {
      env: home.env(),
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
    });
    daemon.unref();
    await new Promise<void>((resolve) => daemon.stdout.once("data", () => resolve()));
    return {
      pid: daemon.pid!,
      requests: async (method) => (await readFile(requestLog, "utf-8")).split("\n").filter((line) => line === method),
    };
  }

  function connectBridge(script: string = cliScript) {
    scripts.add(script);
    return home.connectBridge(script);
  }

  async function runCli(script: string, ...args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    scripts.add(script);
    const child = spawn(process.execPath, [script, ...args], { env: home.env(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    return { exitCode, stdout, stderr };
  }

  describe("a bridge finding a daemon from another version", () => {
    it("replaces a daemon from an older version: calls in flight on it fail once, and bridges attached to it move to the new one", async () => {
      await workspace();
      const oldCli = await cliAt("0.9.0");
      const old = await startDaemon(oldCli);
      expect(old.appVersion).toBe("0.9.0");
      const oldBridge = await connectBridge(oldCli);
      expect(await callStubTool(oldBridge)).toEqual(CALLED);
      const inFlight = callStubToolResult(oldBridge, "slow", { ms: 10_000 });

      const newBridge = await connectBridge();

      expect(await callStubTool(newBridge)).toEqual(CALLED);
      expect(await inFlight).toMatchObject(errorResult('Upstream server "stub" error: daemon shutdown'));
      const replaced = await home.status();
      expect(replaced).toMatchObject({ appVersion: APP_VERSION });
      expect(replaced!.pid).not.toBe(old.pid);
      expect(processExists(old.pid)).toBe(false);
      await until(async () => (await home.status())?.sessions.length === 2, 20_000);
      expect(await callStubTool(oldBridge)).toEqual(CALLED);
      expect(await home.status()).toMatchObject({ pid: replaced!.pid });
      expect(newBridge.stderr()).not.toContain(STILL_RUNNING);
    });

    it.each([
      ["one that stops when asked", []],
      ["one that ignores the request to stop", ["--ignore-shutdown"]],
    ])("replaces a daemon too old to report its version: %s", async (_name, flags) => {
      await workspace();
      const old = await startOlderDaemon(...flags);

      const bridge = await connectBridge();

      expect(await callStubTool(bridge)).toEqual(CALLED);
      expect(await home.status()).toMatchObject({ appVersion: APP_VERSION });
      expect(processExists(old.pid)).toBe(false);
      expect(await old.requests("SHUTDOWN")).toEqual(["SHUTDOWN"]);
      expect(bridge.stderr()).not.toContain(STILL_RUNNING);
    });

    it.each([
      ["the same", APP_VERSION],
      ["a newer", "99.0.0"],
    ])("uses a daemon of %s version as is", async (_name, version) => {
      await workspace();
      const running = await startDaemon(version === APP_VERSION ? cliScript : await cliAt(version));

      const bridge = await connectBridge();

      expect(await callStubTool(bridge)).toEqual(CALLED);
      expect(await home.status()).toMatchObject({ pid: running.pid, appVersion: version });
    });

    it("leaves a release daemon to a bridge from a pre-release version", async () => {
      await workspace();
      const running = await startDaemon(cliScript);

      const bridge = await connectBridge(await cliAt("99.0.0-beta.1"));

      expect(await callStubTool(bridge)).toEqual(CALLED);
      expect(await home.status()).toMatchObject({ pid: running.pid, appVersion: APP_VERSION });
      expect(bridge.stderr()).not.toContain(STILL_RUNNING);
    });

    it("asks an older daemon to stop once when two bridges find it at the same time", async () => {
      await workspace();
      const old = await startOlderDaemon("--ignore-shutdown");

      const bridges = await Promise.all([connectBridge(), connectBridge()]);

      expect(await Promise.all(bridges.map((bridge) => callStubTool(bridge)))).toEqual([CALLED, CALLED]);
      expect(processExists(old.pid)).toBe(false);
      expect(await old.requests("SHUTDOWN")).toEqual(["SHUTDOWN"]);
      expect(daemonPidsRunning(cliScript)).toEqual([(await home.status())!.pid]);
      for (const bridge of bridges) expect(bridge.stderr()).not.toContain(STILL_RUNNING);
    });

    it("tries the replacement once per bridge, using an older daemon that came back after it, with a warning", async () => {
      await workspace({ reconnect: { reconnectBaseDelay: 100, reconnectMaxDelay: 1_000 } });
      const old = await startOlderDaemon("--relaunch-on-shutdown");

      const bridge = await connectBridge();
      await until(async () => bridge.stderr().includes(STILL_RUNNING_WARNING), 20_000);
      const opensAfterReplacement = (await old.requests("OPEN")).length;
      await until(async () => (await old.requests("OPEN")).length >= opensAfterReplacement + 2, 20_000);

      expect(await old.requests("SHUTDOWN")).toEqual(["SHUTDOWN"]);
      const running = await home.status();
      expect(running).not.toBeNull();
      expect(running!.appVersion).toBeUndefined();
      expect(occurrences(bridge.stderr(), STILL_RUNNING_WARNING)).toBe(1);
    });

    it("stops the daemon recorded in the run directory, not a process the older daemon names in its status", async () => {
      await workspace();
      const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
      try {
        const old = await startOlderDaemon("--ignore-shutdown", "--status-pid-json", String(bystander.pid));

        const bridge = await connectBridge();

        expect(await callStubTool(bridge)).toEqual(CALLED);
        expect(processExists(old.pid)).toBe(false);
        expect(processExists(bystander.pid!)).toBe(true);
        expect(await home.status()).toMatchObject({ appVersion: APP_VERSION });
      } finally {
        bystander.kill("SIGKILL");
      }
    });
  });

  describe("a daemon launched to replace another", () => {
    function launchSuccessor(awaitPredecessorMs: number): ChildProcess {
      scripts.add(cliScript);
      return spawn(process.execPath, [cliScript, ...DAEMON_LAUNCH_ARGS, AWAIT_PREDECESSOR_FLAG, String(awaitPredecessorMs)], {
        env: home.env(),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    }

    it("reports that it is serving when nothing is in its way", async () => {
      await workspace();

      expect(await successorReport(launchSuccessor(2_000))).toBe("serving");
      expect(await home.status()).toMatchObject({ appVersion: APP_VERSION });
    });

    it("reports that it is waiting while another daemon holds the run dir, then gives up once its wait runs out", async () => {
      await workspace();
      const running = await startDaemon(cliScript);
      const successor = launchSuccessor(300);
      const exited = new Promise((resolve) => successor.once("exit", resolve));

      expect(await successorReport(successor)).toBe("waiting");
      expect(await exited).toBe(0);
      expect((await home.status())?.pid).toBe(running.pid);
    });
  });

  describe("daemon start", () => {
    it("exits with the refusal, instead of reporting it running, when the daemon no longer accepts this bridge", async () => {
      await workspace();
      const refusing = await startOlderDaemon(
        "--status-version",
        "99.0.0",
        "--status-extra-json",
        JSON.stringify({ minBridgeProtocolVersion: PROTOCOL_VERSION + 1 }),
      );

      const result = await runCli(cliScript, "daemon", "start");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(`the running daemon (${APP_NAME} 99.0.0) no longer accepts bridges from ${APP_NAME} ${APP_VERSION}`);
      expect(await refusing.requests("SHUTDOWN")).toEqual([]);
    });

    it("replaces a daemon from an older version", async () => {
      await workspace();
      const old = await startDaemon(await cliAt("0.9.0"));

      const result = await runCli(cliScript, "daemon", "start");

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("daemon started");
      expect(await home.status()).toMatchObject({ appVersion: APP_VERSION });
      expect(processExists(old.pid)).toBe(false);
    });

    it("fails when a daemon speaking a protocol too old for this bridge is still running after the replacement", async () => {
      await workspace();
      const tooOld = await startOlderDaemon("--relaunch-on-shutdown", "--status-version", APP_VERSION, "--status-extra-json", JSON.stringify({ version: 0 }));

      const result = await runCli(cliScript, "daemon", "start");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `the running daemon (${APP_NAME} ${APP_VERSION}) speaks a protocol too old for this bridge (${APP_NAME} ${APP_VERSION}) and could not be replaced; run \`${APP_NAME} daemon stop\`, then try again`,
      );
      expect(await tooOld.requests("SHUTDOWN")).toEqual(["SHUTDOWN"]);
    });

    it("fails when an older daemon is still running after the replacement, naming its version", async () => {
      await workspace();
      await startOlderDaemon("--relaunch-on-shutdown", "--status-version", "0.8.0");

      const result = await runCli(cliScript, "daemon", "start");

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `a daemon from an older ${APP_NAME} version (0.8.0) is still running and could not be replaced; run \`${APP_NAME} daemon stop\`, then start again`,
      );
    });
  });

  describe("daemon status", () => {
    it("shows the daemon's version and an empty set of refused requests", async () => {
      await workspace();
      const running = await startDaemon(cliScript);

      const result = await runCli(cliScript, "daemon", "status");

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        running: true,
        logFile: daemonLogPath(),
        pid: running.pid,
        uptime: expect.any(Number),
        appVersion: APP_VERSION,
        refusedUpstreamRequests: {},
        children: [],
      });
    });

    it("shows the protocol era of each server a bridge is using", async () => {
      await workspace();
      const bridge = await connectBridge();
      expect(await callStubTool(bridge)).toEqual(CALLED);

      const result = await runCli(cliScript, "daemon", "status");

      expect(JSON.parse(result.stdout).children).toEqual([{ server: "stub", era: "legacy" }]);
    });

    it("shows each server's era sorted by name, with control and format characters in names escaped", async () => {
      await workspace();
      const hostile = `z${String.fromCodePoint(0x1b)}[2J${String.fromCodePoint(0x202e)}`;
      const children = [
        { serverName: hostile, era: "unknown" },
        { serverName: "github", era: "modern" },
        { serverName: "linear", era: "legacy" },
      ];
      await startOlderDaemon("--status-children-json", JSON.stringify(children));

      const result = await runCli(cliScript, "daemon", "status");

      expect(JSON.parse(result.stdout).children).toEqual([
        { server: "github", era: "modern" },
        { server: "linear", era: "legacy" },
        { server: "z\\x1b[2J\\u202e", era: "unknown" },
      ]);
    });

    it.each([
      ["children without a name or era, as daemons before eras report them", [{ pid: 1, upstreamHash: "h" }]],
      ["an era the bridge doesn't know", [{ serverName: "linear", era: "future" }]],
      ["children that are not a list", { linear: "modern" }],
    ])("shows no children for %s", async (_case, children) => {
      await workspace();
      await startOlderDaemon("--status-children-json", JSON.stringify(children));

      const result = await runCli(cliScript, "daemon", "status");

      expect(JSON.parse(result.stdout).children).toBeNull();
    });

    it("shows a refused-request count of 0 as it is", async () => {
      await workspace();
      await startOlderDaemon("--status-version", "0.8.0", "--status-refused-json", JSON.stringify({ "roots/list": 0 }));

      const result = await runCli(cliScript, "daemon", "status");

      expect(JSON.parse(result.stdout).refusedUpstreamRequests).toEqual({ "roots/list": 0 });
    });

    it("shows the requests a daemon refused, by method", async () => {
      await workspace();
      const old = await startOlderDaemon("--status-version", "0.8.0", "--status-refused-json", JSON.stringify({ "roots/list": 1 }));

      const result = await runCli(cliScript, "daemon", "status");

      expect(JSON.parse(result.stdout)).toEqual({
        running: true,
        logFile: daemonLogPath(),
        pid: old.pid,
        uptime: 1,
        appVersion: "0.8.0",
        refusedUpstreamRequests: { "roots/list": 1 },
        children: [],
      });
    });

    it("escapes control and format characters in the refused method names a daemon reports", async () => {
      await workspace();
      const hostile = `a${String.fromCodePoint(0x1b)}[2J${String.fromCodePoint(0x202e)}b`;
      await startOlderDaemon("--status-version", "0.8.0", "--status-refused-json", JSON.stringify({ [hostile]: 2 }));

      const result = await runCli(cliScript, "daemon", "status");

      expect(JSON.parse(result.stdout).refusedUpstreamRequests).toEqual({ "a\\x1b[2J\\u202eb": 2 });
    });

    it.each([
      ["a count that is not a number", { "roots/list": "1" }],
      ["a fractional count", { "roots/list": 1.5 }],
      ["a negative count", { "roots/list": -1 }],
      ["a list instead of counts by method", [1]],
    ])("shows no refused requests for %s", async (_case, refused) => {
      await workspace();
      await startOlderDaemon("--status-version", "0.8.0", "--status-refused-json", JSON.stringify(refused));

      const result = await runCli(cliScript, "daemon", "status");

      expect(JSON.parse(result.stdout).refusedUpstreamRequests).toBeNull();
    });

    it.each([
      ["null for a pid that isn't a number", JSON.stringify(`1${String.fromCodePoint(0x9b)}31m`), "1", { pid: null, uptime: 1 }],
      ["null for pid 0", "0", "1", { pid: null, uptime: 1 }],
      ["null for a negative uptime", "1234", "-5", { pid: 1234, uptime: null }],
      ["an uptime of 0 as it is", "1234", "0", { pid: 1234, uptime: 0 }],
    ])("shows %s", async (_case, pid, uptime, shown) => {
      await workspace();
      await startOlderDaemon("--status-pid-json", pid, "--status-uptime-json", uptime);

      const result = await runCli(cliScript, "daemon", "status");

      expect(JSON.parse(result.stdout)).toMatchObject({ running: true, ...shown });
    });

    it("shows a daemon too old to report its version or refused requests", async () => {
      await workspace();
      const old = await startOlderDaemon();

      const result = await runCli(cliScript, "daemon", "status");

      expect(JSON.parse(result.stdout)).toEqual({
        running: true,
        logFile: daemonLogPath(),
        pid: old.pid,
        uptime: 1,
        appVersion: "unknown",
        refusedUpstreamRequests: null,
        children: [],
      });
    });

    it("shows the same fields for a recorded daemon that does not answer", async () => {
      await workspace();
      const { pidPath } = daemonFilesFor(home.socketPath);
      await mkdir(dirname(pidPath), { recursive: true });
      await writeFile(pidPath, `${process.pid}\n`);

      const result = await runCli(cliScript, "daemon", "status");

      expect(JSON.parse(result.stdout)).toEqual({
        running: true,
        logFile: daemonLogPath(),
        pid: process.pid,
        uptime: null,
        appVersion: "unknown",
        refusedUpstreamRequests: null,
        children: null,
      });
    });
  });
});
