import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DaemonRefusesBridgeError, DaemonTooOldError, DaemonUnreachableError, daemonStatus } from "../../src/daemon/bootstrap.js";
import { PROTOCOL_VERSION } from "../../src/daemon/protocol.js";
import type { DaemonLauncher } from "../../src/daemon/daemon-launch.js";
import { DAEMON_LAUNCH_ARGS } from "../../src/daemon/daemon-identity.js";
import { APP_VERSION } from "../../src/constants.js";
import { spyLogger } from "../_helpers/spy-logger.js";
import { stillOutdated, useOutdatedDaemonFixture } from "../_helpers/outdated-daemon-fixture.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("ensureDaemonRunning with a daemon that only answers after the bridge has started its own", { timeout: 30_000 }, () => {
  const {
    paths,
    launches,
    launchOptions,
    children,
    serveTracked,
    serveOlderDaemon,
    serveOlderDaemonGoneOnceGuardHeld,
    countLaunch,
    launchCurrentDaemon,
    launchDaemonReporting,
    ensure,
    requestsNamed,
  } = useOutdatedDaemonFixture();

  it("tries its one replacement on an older daemon that answers once the bridge has launched its own, then warns and uses it", async () => {
    const logger = spyLogger();

    await ensure({ logger, launch: launchDaemonReporting({}) });

    expect(launches).toHaveLength(1);
    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
    expect(logger.warn.mock.calls).toEqual([stillOutdated()]);
  });

  it("replaces an older daemon that answers once the bridge has launched its own, launching a second time", async () => {
    const logger = spyLogger();
    const launchOlderThenCurrent: DaemonLauncher = async (opts) => {
      if (launches.length > 0) return launchCurrentDaemon(opts);
      await countLaunch();
      void serveOlderDaemon("stop");
      return "launched";
    };

    await ensure({ logger, launch: launchOlderThenCurrent });

    expect(launches).toHaveLength(2);
    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
    expect(await daemonStatus(paths.socketPath)).toMatchObject({ appVersion: APP_VERSION });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("launches only once when a late older daemon is gone by the time the guard is held and nothing else answers", async () => {
    const launchVanishingOlderDaemon: DaemonLauncher = async () => {
      await countLaunch();
      void serveOlderDaemonGoneOnceGuardHeld();
      return "launched";
    };

    await expect(ensure({ launch: launchVanishingOlderDaemon })).rejects.toThrow(DaemonUnreachableError);

    expect(launches).toHaveLength(1);
    expect(requestsNamed("SHUTDOWN")).toEqual([]);
  });

  it("tries to replace a daemon too old for this bridge that answers once the bridge has launched its own, then refuses it", async () => {
    await expect(ensure({ launch: launchDaemonReporting({ appVersion: APP_VERSION, version: 0 }) })).rejects.toBeInstanceOf(
      DaemonTooOldError,
    );

    expect(launches).toHaveLength(1);
    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
  });

  it("refuses a daemon that no longer accepts this bridge when it answers once the bridge has launched its own", async () => {
    await expect(
      ensure({ launch: launchDaemonReporting({ appVersion: "99.0.0", minBridgeProtocolVersion: PROTOCOL_VERSION + 1 }) }),
    ).rejects.toBeInstanceOf(DaemonRefusesBridgeError);

    expect(launches).toHaveLength(1);
    expect(requestsNamed("SHUTDOWN")).toEqual([]);
  });

  it("tries to replace a recorded daemon that turns out too old for this bridge once it has finished starting, then refuses it", async () => {
    const starting = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", ...DAEMON_LAUNCH_ARGS], { stdio: "ignore" });
    children.push(starting);
    await writeFile(paths.lockPath, `${starting.pid}\ntoken\n`);
    setTimeout(() => void serveTracked(() => ({ pid: starting.pid, appVersion: APP_VERSION, version: 0 })), 300);

    await expect(ensure({ _startingDaemonWaitMs: 5_000 })).rejects.toBeInstanceOf(DaemonTooOldError);

    expect(launchOptions).toEqual([{ awaitPredecessorMs: expect.any(Number) }]);
  });

  it("keeps waiting when the daemon it launched is taken over by another before answering", async () => {
    const daemonLike = () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", ...DAEMON_LAUNCH_ARGS], { stdio: "ignore" });
      children.push(child);
      return child;
    };
    const launchThenHandOver: DaemonLauncher = async (opts) => {
      await countLaunch(opts);
      const launched = daemonLike();
      await writeFile(paths.lockPath, `${launched.pid}\nlaunched\n`);
      setTimeout(() => {
        const takeover = daemonLike();
        void writeFile(paths.lockPath, `${takeover.pid}\ntakeover\n`);
        setTimeout(() => void serveTracked(() => ({ pid: takeover.pid, appVersion: APP_VERSION })), 1_500);
      }, 3_500);
      return "launched";
    };

    await ensure({ launch: launchThenHandOver, _startingDaemonWaitMs: 10_000 });

    expect(launches).toHaveLength(1);
    expect(await daemonStatus(paths.socketPath)).toMatchObject({ appVersion: APP_VERSION });
  });
});
