import { describe, it, expect } from "vitest";
import { APP_NAME } from "../../src/constants.js";
import { PROTOCOL_VERSION } from "../../src/daemon/protocol.js";
import {
  daemonFit,
  daemonVersionLabel,
  isOutdatedDaemon,
  olderDaemonStillRunning,
  refusesThisBridge,
  reportedDaemonPid,
  tooOldForThisBridge,
} from "../../src/daemon/daemon-version.js";

describe("isOutdatedDaemon ordering", () => {
  it.each([
    ["1.2.3", "1.2.3", false],
    ["1.2.3", "1.2.4", true],
    ["1.2.10", "1.2.9", false],
    ["1.2.9", "1.2.10", true],
    ["1.2.99", "1.3.0", true],
    ["1.9.9", "2.0.0", true],
    ["10.0.0", "9.0.0", false],
    ["9.0.0", "10.0.0", true],
    ["2.0.0-rc.1", "2.0.0", true],
    ["2.0.0+build.5", "2.0.0", false],
    ["1.9.0+build.5", "2.0.0", true],
  ])("treats a daemon reporting %s as outdated for bridge %s: %s", (appVersion, ours, expected) => {
    expect(isOutdatedDaemon({ appVersion }, ours)).toBe(expected);
  });

  it.each([
    ["2.0.0-alpha", "2.0.0-alpha.1", true],
    ["2.0.0-alpha.1", "2.0.0-alpha.beta", true],
    ["2.0.0-beta.2", "2.0.0-beta.11", true],
    ["2.0.0-beta.11", "2.0.0-beta.2", false],
    ["2.0.0-beta", "2.0.0-alpha", false],
    ["2.0.0-alpha.beta", "2.0.0-alpha.1", false],
  ])("orders pre-releases: a daemon reporting %s is outdated for bridge %s: %s", (appVersion, ours, expected) => {
    expect(isOutdatedDaemon({ appVersion }, ours)).toBe(expected);
  });

  it.each(["", "1.0", "v1.0.0", "1.0.0-", "latest"])("leaves a daemon reporting %j, which doesn't parse, as it is", (appVersion) => {
    expect(isOutdatedDaemon({ appVersion }, "2.0.0")).toBe(false);
  });
});

describe("daemonVersionLabel", () => {
  it.each([
    [{ appVersion: "1.3.0" }, "1.3.0"],
    [{ appVersion: "2.0.0-rc.1+build.7" }, "2.0.0-rc.1+build.7"],
    [{ appVersion: "x".repeat(64) }, "x".repeat(64)],
    [{ appVersion: "x".repeat(65) }, "unknown"],
    [{ appVersion: "1.0.0\u001b[31m" }, "unknown"],
    [{ appVersion: "1.0 .0" }, "unknown"],
    [{ appVersion: `1.0.0${String.fromCodePoint(0x7f)}` }, "unknown"],
    [{ appVersion: `1.0.0${String.fromCodePoint(0x9b)}31m` }, "unknown"],
    [{ appVersion: `1.0.0${String.fromCodePoint(0x2028)}` }, "unknown"],
    [{ appVersion: `2.0.0-${String.fromCodePoint(0xe9)}` }, "unknown"],
    [{ appVersion: "" }, "unknown"],
    [{ appVersion: 2 }, "unknown"],
    [{}, "unknown"],
  ])("labels %j as %s", (status, expected) => {
    expect(daemonVersionLabel(status)).toBe(expected);
  });
});

describe("isOutdatedDaemon", () => {
  it.each([
    ["1.9.0", true],
    ["2.0.0-rc.1", true],
    ["2.0.0", false],
    ["2.0.1", false],
    ["3.0.0", false],
  ])("treats a daemon reporting %s as outdated: %s (bridge 2.0.0)", (appVersion, expected) => {
    expect(isOutdatedDaemon({ appVersion }, "2.0.0")).toBe(expected);
  });

  it("treats a daemon too old to report a version as outdated", () => {
    expect(isOutdatedDaemon({}, "2.0.0")).toBe(true);
  });

  it.each([[{ appVersion: "" }], [{ appVersion: 2 }], [{ appVersion: null }], [{ appVersion: "junk" }]])(
    "leaves a daemon reporting a version it can't read, %j, as it is",
    (status) => {
      expect(isOutdatedDaemon(status, "2.0.0")).toBe(false);
    },
  );

  it("never treats a daemon as outdated when the bridge's own version does not parse", () => {
    expect(isOutdatedDaemon({}, "dev")).toBe(false);
    expect(isOutdatedDaemon({ appVersion: "0.0.1" }, "dev")).toBe(false);
  });

  it.each([
    [{ appVersion: "2.0.0" }, false],
    [{ appVersion: "1.0.0" }, false],
    [{}, false],
    [{ appVersion: "junk" }, false],
    [{ appVersion: "2.1.0-beta.2" }, false],
    [{ appVersion: "2.1.0-alpha.9" }, true],
    [{ appVersion: "2.0.0-rc.1" }, true],
  ])("lets a pre-release bridge (2.1.0-beta.1) replace only an older pre-release: %j outdated %s", (status, expected) => {
    expect(isOutdatedDaemon(status, "2.1.0-beta.1")).toBe(expected);
  });
});

describe("tooOldForThisBridge", () => {
  it.each([
    [{ version: 1 }, false],
    [{ version: 2 }, false],
    [{ version: 0 }, true],
    [{}, false],
    [{ version: "0" }, false],
  ])("for a bridge that needs protocol 1, %j speaks an older one: %s", (status, expected) => {
    expect(tooOldForThisBridge(status, 1)).toBe(expected);
  });

  it.each([
    [{ version: 1 }, true],
    [{ version: PROTOCOL_VERSION }, false],
  ])("for a later bridge that needs this release's protocol, %j speaks an older one: %s", (status, expected) => {
    expect(tooOldForThisBridge(status, PROTOCOL_VERSION)).toBe(expected);
  });

  it("makes a daemon of the same crabeye version outdated when its protocol is too old", () => {
    expect(isOutdatedDaemon({ appVersion: "2.0.0", version: 0 }, "2.0.0")).toBe(true);
    expect(isOutdatedDaemon({ appVersion: "2.1.0", version: 0 }, "2.1.0-beta.1")).toBe(true);
  });
});

describe("daemonFit", () => {
  it.each([
    [{ appVersion: "99.0.0", minBridgeProtocolVersion: 99 }, "refuses-bridge"],
    [{ appVersion: "0.1.0", version: 0, minBridgeProtocolVersion: 99 }, "refuses-bridge"],
    [{ appVersion: "99.0.0", version: 0 }, "too-old"],
    [{ appVersion: "0.1.0" }, "older"],
    [{}, "older"],
    [{ version: 1 }, "too-old"],
    [{ appVersion: "99.0.0", version: 2, minBridgeProtocolVersion: 1 }, "too-old"],
    [{ appVersion: "99.0.0", version: PROTOCOL_VERSION, minBridgeProtocolVersion: 1 }, "current"],
    [{ appVersion: "99.0.0", version: PROTOCOL_VERSION, minBridgeProtocolVersion: PROTOCOL_VERSION }, "current"],
    [{ appVersion: "99.0.0", version: PROTOCOL_VERSION, minBridgeProtocolVersion: PROTOCOL_VERSION + 1 }, "refuses-bridge"],
    [{ appVersion: "junk" }, "current"],
  ])("classifies %j as %s", (status, fit) => {
    expect(daemonFit(status)).toBe(fit);
  });
});

describe("refusesThisBridge", () => {
  it.each([
    [{ minBridgeProtocolVersion: 2 }, true],
    [{ minBridgeProtocolVersion: 1 }, false],
    [{ minBridgeProtocolVersion: 0 }, false],
    [{}, false],
    [{ minBridgeProtocolVersion: "2" }, false],
  ])("for a bridge speaking protocol 1, %j refuses it: %s", (status, expected) => {
    expect(refusesThisBridge(status, 1)).toBe(expected);
  });
});

describe("reportedDaemonPid", () => {
  it.each([
    [{ pid: 4242 }, 4242],
    [{ pid: 1 }, 1],
    [{ pid: 0 }, null],
    [{ pid: -5 }, null],
    [{ pid: 1.5 }, null],
    [{ pid: 2 ** 53 }, null],
    [{ pid: "4242" }, null],
    [{}, null],
  ])("reads the pid of %j as %j", (status, pid) => {
    expect(reportedDaemonPid(status)).toBe(pid);
  });
});

describe("olderDaemonStillRunning", () => {
  it.each([
    [{ appVersion: "0.9.0" }, "0.9.0"],
    [{ appVersion: "1.0.0\u001b[2J" }, "unknown"],
    [{}, "unknown"],
  ])("names the version of %j as %s", (status, label) => {
    expect(olderDaemonStillRunning(status)).toBe(`a daemon from an older ${APP_NAME} version (${label}) is still running`);
  });
});
