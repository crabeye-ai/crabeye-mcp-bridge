import { existsSync } from "node:fs";
import { unlink, utimes } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { DaemonRefusesBridgeError, DaemonTooOldError, DaemonUnreachableError, daemonStatus } from "../../src/daemon/bootstrap.js";
import { PROTOCOL_VERSION } from "../../src/daemon/protocol.js";
import { APP_NAME, APP_VERSION } from "../../src/constants.js";
import { loadDaemonShutdownWaitMs } from "../../src/config/bridge-config.js";
import { spyLogger } from "../_helpers/spy-logger.js";
import { NO_REPLY } from "../_helpers/frame-server.js";
import { stillOutdated, useOutdatedDaemonFixture } from "../_helpers/outdated-daemon-fixture.js";

const isWindows = process.platform === "win32";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(isWindows)("ensureDaemonRunning with a daemon it can't use as is", { timeout: 30_000 }, () => {
  const {
    paths,
    requests,
    launches,
    launchOptions,
    useKillGrace,
    serveTracked,
    closeServers,
    serveOlderDaemon,
    recoveryGuardHeld,
    serveOlderDaemonGoneOnceGuardHeld,
    launchCurrentDaemon,
    ensure,
    requestsNamed,
    holdRecoveryGuardInAnotherBridge,
  } = useOutdatedDaemonFixture();

  it("waits while another bridge holds the recovery guard, then tries itself when the daemon is still older", async () => {
    await serveOlderDaemon("keep-serving");
    const guardPath = await holdRecoveryGuardInAnotherBridge();
    const logger = spyLogger();
    let settled = false;

    const attempt = ensure({ logger }).finally(() => (settled = true));
    await wait(1_500);
    expect(settled).toBe(false);
    expect(requestsNamed("SHUTDOWN")).toEqual([]);

    await unlink(guardPath);
    await attempt;

    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
    expect(launches).toEqual([]);
    expect(logger.warn.mock.calls).toEqual([stillOutdated()]);
  });

  async function expectGuardRespected(guardAgeMs: number): Promise<void> {
    let replacedByOtherBridge = false;
    await serveOlderDaemon("keep-serving", () => (replacedByOtherBridge ? { appVersion: APP_VERSION } : {}));
    const guardPath = await holdRecoveryGuardInAnotherBridge();
    const replacementStartedAgo = new Date(Date.now() - guardAgeMs);
    await utimes(guardPath, replacementStartedAgo, replacementStartedAgo);
    let settled = false;

    const attempt = ensure().finally(() => (settled = true));
    try {
      await wait(1_500);
      expect(settled).toBe(false);
      expect(requestsNamed("SHUTDOWN")).toEqual([]);
    } finally {
      replacedByOtherBridge = true;
      await unlink(guardPath).catch(() => {});
      await attempt.catch(() => {});
    }
  }

  it("respects another live bridge's recovery guard for as long as a whole replacement can take", async () => {
    await expectGuardRespected(100_000);
  });

  it("counts both kill graces of a replacement in how long it respects another bridge's recovery guard", async () => {
    await useKillGrace(5_000);

    await expectGuardRespected(125_000);
  });

  it("stops waiting for another bridge's replacement as soon as a current daemon answers", async () => {
    let replacedByOtherBridge = false;
    await serveOlderDaemon("keep-serving", () => (replacedByOtherBridge ? { appVersion: APP_VERSION } : {}));
    const guardPath = await holdRecoveryGuardInAnotherBridge();
    const logger = spyLogger();

    const attempt = ensure({ logger });
    await wait(300);
    replacedByOtherBridge = true;
    await attempt;

    expect(existsSync(guardPath)).toBe(true);
    expect(requestsNamed("SHUTDOWN")).toEqual([]);
    expect(launches).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("tries the replacement once per process, then uses the older daemon without asking it to stop again", async () => {
    await serveOlderDaemon("keep-serving");
    const first = spyLogger();
    await ensure({ logger: first });
    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
    expect(launches).toEqual([]);
    expect(first.warn.mock.calls).toEqual([stillOutdated()]);

    const second = spyLogger();
    await ensure({ logger: second });
    await ensure({ logger: second, freshAttempt: true });

    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
    expect(launches).toEqual([]);
    expect(second.warn).not.toHaveBeenCalled();
  });

  it("warns once for each different older daemon it ends up using after its attempt", async () => {
    let pid = process.pid;
    await serveOlderDaemon("keep-serving", () => ({ pid }));
    const logger = spyLogger();
    await ensure({ logger });

    pid = process.pid + 1;
    await ensure({ logger, freshAttempt: true });
    await ensure({ logger, freshAttempt: true });

    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
    expect(logger.warn.mock.calls).toEqual([stillOutdated(), stillOutdated()]);
  });

  it("warns once for an older daemon whose pid isn't a usable number, however that pid changes", async () => {
    await serveOlderDaemon("keep-serving", (statusCount) => ({ pid: `not-a-pid-${statusCount}` }));
    const logger = spyLogger();

    await ensure({ logger });
    await ensure({ logger, freshAttempt: true });
    await ensure({ logger, freshAttempt: true });

    expect(logger.warn.mock.calls).toEqual([stillOutdated()]);
  });

  it("warns again when an older daemon it warned about earlier answers again after a different one", async () => {
    let pid = process.pid;
    await serveOlderDaemon("keep-serving", () => ({ pid }));
    const logger = spyLogger();
    await ensure({ logger });

    pid = process.pid + 1;
    await ensure({ logger, freshAttempt: true });
    pid = process.pid;
    await ensure({ logger, freshAttempt: true });

    expect(logger.warn.mock.calls).toEqual([stillOutdated(), stillOutdated(), stillOutdated()]);
  });

  it("asks a current daemon for its status once per ensure", async () => {
    await serveOlderDaemon("keep-serving", () => ({ appVersion: APP_VERSION }));

    await ensure();

    expect(requests).toEqual(["STATUS"]);
  });

  it("asks an older daemon it already tried to replace for its status once per later ensure", async () => {
    await serveOlderDaemon("keep-serving");
    await ensure();
    requests.length = 0;

    await ensure({ freshAttempt: true });

    expect(requests).toEqual(["STATUS"]);
  });

  it("names a version too long to print as unknown in the warning", async () => {
    await serveOlderDaemon("keep-serving", () => ({ appVersion: `1.0.0-${"a".repeat(70)}` }));
    const logger = spyLogger();

    await ensure({ logger });

    expect(logger.warn.mock.calls).toEqual([stillOutdated("unknown")]);
  });

  it("names the older version in the warning", async () => {
    await serveOlderDaemon("keep-serving", () => ({ appVersion: "0.9.0" }));
    const logger = spyLogger();

    await ensure({ logger });

    expect(logger.warn.mock.calls).toEqual([stillOutdated("0.9.0")]);
  });

  it("keeps waiting while no daemon answers during another bridge's replacement, then launches once it ends", async () => {
    await serveOlderDaemon("keep-serving");
    const guardPath = await holdRecoveryGuardInAnotherBridge();
    let settled = false;

    const attempt = ensure({ launch: launchCurrentDaemon }).finally(() => (settled = true));
    await wait(300);
    await closeServers();
    await wait(1_200);
    expect(settled).toBe(false);
    expect(launches).toEqual([]);
    await unlink(guardPath);
    await attempt;

    expect(launches).toHaveLength(1);
    expect(requestsNamed("SHUTDOWN")).toEqual([]);
  });

  it("makes its own attempt when an older daemon is back after another bridge's replacement ends", async () => {
    await serveOlderDaemon("keep-serving");
    const guardPath = await holdRecoveryGuardInAnotherBridge();
    const logger = spyLogger();

    const attempt = ensure({ logger });
    await wait(300);
    await closeServers();
    await wait(300);
    await serveOlderDaemon("keep-serving");
    await unlink(guardPath);
    await attempt;

    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
    expect(logger.warn.mock.calls).toEqual([stillOutdated()]);
  });

  it("launches a daemon when the older one is gone by the time the guard is held", async () => {
    await serveOlderDaemonGoneOnceGuardHeld();

    await ensure({ launch: launchCurrentDaemon });

    expect(launches).toHaveLength(1);
    expect(requestsNamed("SHUTDOWN")).toEqual([]);
  });

  it("waits for an older daemon to stop even when its reply to SHUTDOWN never arrives", async () => {
    const logger = spyLogger();
    await serveTracked(({ method }, server) => {
      requests.push(method);
      if (method !== "SHUTDOWN") return { pid: process.pid };
      setTimeout(() => server.close(() => requests.push("closed")), 1_500);
      return NO_REPLY;
    });

    await ensure({ logger, launch: launchCurrentDaemon });

    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
    expect(requests.filter((name) => name === "closed" || name === "launch")).toEqual(["closed", "launch"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("neither stops nor waits on a daemon that has become current by the time it would be asked to stop", async () => {
    const shutdownCheck = 2;
    let statusesWhileReplacing = 0;
    await serveOlderDaemon("keep-serving", () => {
      if (recoveryGuardHeld()) statusesWhileReplacing++;
      return statusesWhileReplacing >= shutdownCheck ? { appVersion: APP_VERSION } : {};
    });
    const shutdownWaitMs = await loadDaemonShutdownWaitMs();
    const startedAt = Date.now();

    await ensure({ launch: launchCurrentDaemon });

    expect(statusesWhileReplacing).toBe(shutdownCheck);
    expect(requestsNamed("SHUTDOWN")).toEqual([]);
    expect(launches).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(shutdownWaitMs - 200);
  });

  it("refuses a daemon speaking a protocol too old for this bridge when it can't replace it", async () => {
    await serveOlderDaemon("keep-serving", () => ({ appVersion: APP_VERSION, version: 0 }));
    const logger = spyLogger();

    const refusal = ensure({ logger });

    await expect(refusal).rejects.toBeInstanceOf(DaemonTooOldError);
    await expect(refusal).rejects.toThrow(
      `the running daemon (${APP_NAME} ${APP_VERSION}) speaks a protocol too old for this bridge (${APP_NAME} ${APP_VERSION}) and could not be replaced; run \`${APP_NAME} daemon stop\`, then try again`,
    );
    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("names a version it can't print as unknown when refusing a daemon speaking a protocol too old", async () => {
    await serveOlderDaemon("keep-serving", () => ({ appVersion: `1.0.0${String.fromCodePoint(0x1b)}[2J`, version: 0 }));

    await expect(ensure()).rejects.toThrow(`the running daemon (${APP_NAME} unknown) speaks a protocol too old for this bridge`);
  });

  it("keeps refusing a daemon speaking a protocol too old on a later ensure, without trying to replace it again", async () => {
    await serveOlderDaemon("keep-serving", () => ({ appVersion: APP_VERSION, version: 0 }));

    await expect(ensure()).rejects.toBeInstanceOf(DaemonTooOldError);
    await expect(ensure()).rejects.toBeInstanceOf(DaemonTooOldError);

    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
  });

  it("refuses an older daemon that also no longer accepts this bridge, without trying to replace it", async () => {
    await serveOlderDaemon("keep-serving", () => ({ appVersion: "0.1.0", minBridgeProtocolVersion: PROTOCOL_VERSION + 1 }));

    await expect(ensure()).rejects.toBeInstanceOf(DaemonRefusesBridgeError);

    expect(requestsNamed("SHUTDOWN")).toEqual([]);
    expect(launches).toEqual([]);
  });

  it("leaves a daemon alone when it reports a current version by the time the guard is held", async () => {
    let current = false;
    await serveOlderDaemon("keep-serving", () => {
      if (recoveryGuardHeld()) current = true;
      return current ? { appVersion: APP_VERSION } : {};
    });
    const logger = spyLogger();

    await ensure({ logger, launch: launchCurrentDaemon });

    expect(launches).toEqual([]);
    expect(requestsNamed("SHUTDOWN")).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("launches once when the daemon that replaces the older one never answers", async () => {
    await serveOlderDaemon("stop");

    await expect(ensure()).rejects.toThrow(DaemonUnreachableError);

    expect(requestsNamed("SHUTDOWN")).toEqual(["SHUTDOWN"]);
    expect(launches).toHaveLength(1);
  });

  it("launches only after an older daemon that is slow to stop has stopped serving", async () => {
    await serveOlderDaemon({ stopAfterMs: 400 });

    await ensure({ launch: launchCurrentDaemon });

    expect(requests.filter((name) => name === "closed" || name === "launch")).toEqual(["closed", "launch"]);
    expect(launchOptions).toEqual([{}]);
    expect(await daemonStatus(paths.socketPath)).toMatchObject({ appVersion: APP_VERSION });
  });

  it("refuses a daemon that no longer accepts bridges of this protocol version, leaving it running", async () => {
    await serveOlderDaemon("keep-serving", () => ({ appVersion: "99.0.0", minBridgeProtocolVersion: PROTOCOL_VERSION + 1 }));

    const refusal = ensure();

    await expect(refusal).rejects.toBeInstanceOf(DaemonRefusesBridgeError);
    await expect(refusal).rejects.toThrow(
      `the running daemon (${APP_NAME} 99.0.0) no longer accepts bridges from ${APP_NAME} ${APP_VERSION}; upgrade ${APP_NAME}`,
    );
    expect(requestsNamed("SHUTDOWN")).toEqual([]);
    expect(launches).toEqual([]);
  });
});
