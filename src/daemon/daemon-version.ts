import { APP_NAME, APP_VERSION } from "../constants.js";
import { MIN_DAEMON_PROTOCOL_VERSION, PROTOCOL_VERSION, type DaemonStatus } from "./protocol.js";

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const VISIBLE_ASCII_VERSION_RE = /^[\x21-\x7e]{1,64}$/;
export const UNKNOWN_DAEMON_VERSION = "unknown";

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER_RE.exec(version);
  if (match === null) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = compareIdentifiers(a[i]!, b[i]!);
    if (order !== 0) return order;
  }
  return Math.sign(a.length - b.length);
}

function compareParsed(left: ParsedVersion, right: ParsedVersion): number {
  for (let i = 0; i < 3; i++) {
    const order = Math.sign(left.core[i]! - right.core[i]!);
    if (order !== 0) return order;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function daemonVersionLabel(status: Pick<DaemonStatus, "appVersion">): string {
  const { appVersion } = status;
  return typeof appVersion === "string" && VISIBLE_ASCII_VERSION_RE.test(appVersion) ? appVersion : UNKNOWN_DAEMON_VERSION;
}

export function reportedDaemonPid(status: Pick<DaemonStatus, "pid">): number | null {
  const { pid } = status;
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function tooOldForThisBridge(
  status: Pick<DaemonStatus, "version">,
  oldestUsable: number = MIN_DAEMON_PROTOCOL_VERSION,
): boolean {
  return typeof status.version === "number" && status.version < oldestUsable;
}

export function isOutdatedDaemon(status: Pick<DaemonStatus, "appVersion" | "version">, ours: string = APP_VERSION): boolean {
  if (tooOldForThisBridge(status)) return true;
  const bridge = parseVersion(ours);
  if (bridge === null) return false;
  const bridgeIsPrerelease = bridge.prerelease.length > 0;
  if (status.appVersion === undefined) return !bridgeIsPrerelease;
  const daemon = typeof status.appVersion === "string" ? parseVersion(status.appVersion) : null;
  if (daemon === null) return false;
  if (bridgeIsPrerelease && daemon.prerelease.length === 0) return false;
  return compareParsed(daemon, bridge) < 0;
}

export function refusesThisBridge(
  status: Pick<DaemonStatus, "minBridgeProtocolVersion">,
  ours: number = PROTOCOL_VERSION,
): boolean {
  const { minBridgeProtocolVersion } = status;
  return typeof minBridgeProtocolVersion === "number" && minBridgeProtocolVersion > ours;
}

export type DaemonFit = "current" | "older" | "too-old" | "refuses-bridge";

export function daemonFit(status: DaemonStatus): DaemonFit {
  if (refusesThisBridge(status)) return "refuses-bridge";
  if (tooOldForThisBridge(status)) return "too-old";
  return isOutdatedDaemon(status) ? "older" : "current";
}

export function olderDaemonStillRunning(status: Pick<DaemonStatus, "appVersion">): string {
  return `a daemon from an older ${APP_NAME} version (${daemonVersionLabel(status)}) is still running`;
}
