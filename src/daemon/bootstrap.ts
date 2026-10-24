import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "./client.js";
import { daemonFilesFor, getDaemonSocketPath, type DaemonFiles } from "./paths.js";
import { isServing, netTransport } from "./net-transport.js";
import { isSocketAddressError } from "./socket-address.js";
import { SUCCESSOR_REPORT_TIMEOUT_MS, detachedDaemonLauncher, MAX_AWAIT_PREDECESSOR_MS, type DaemonLauncher } from "./daemon-launch.js";
import {
  describeProcess,
  identityOf,
  isSameProcess,
  recordedPids,
  terminateDaemon,
  waitForExit,
  type DaemonProcess,
} from "./daemon-process.js";
import { acquireLock, holdsLock, isLockLive, LockBusyError, type LockHandle } from "../process/lockfile.js";
import { daemonFit, daemonVersionLabel, isOutdatedDaemon, olderDaemonStillRunning, reportedDaemonPid } from "./daemon-version.js";
import type { DaemonStatus } from "./protocol.js";
import { APP_NAME, APP_VERSION } from "../constants.js";
import { createNoopLogger, type Logger } from "../logging/index.js";
import { loadDaemonShutdownWaitMs } from "../config/bridge-config.js";
import { processExists, READ_PROCESS_INFO_MAX_MS, TASKKILL_TIMEOUT_MS } from "../process/process-utils.js";

/**
 * Backoff schedule for "wait for daemon to be reachable after spawn".
 * Cumulative: ~2.75 s. The daemon answers once it has reaped leaked
 * children; while its recorded process is alive but it hasn't answered yet,
 * probing continues for up to STARTING_DAEMON_WAIT_MS.
 */
const CONNECT_BACKOFF_MS = [50, 200, 500, 1000, 1000] as const;
const STARTING_DAEMON_WAIT_MS = 60_000;
const DAEMON_POLL_MS = 1_000;
const PROBE_TIMEOUT_MS = 1_000;
const TERMINATED_DAEMON_EXIT_WAIT_MS = 5_000;
const REPLACEMENT_POLL_MS = 100;
const PROBE_MAX_MS = 2 * PROBE_TIMEOUT_MS;
const SHUTDOWN_REQUEST_MAX_MS = 3 * PROBE_TIMEOUT_MS;
const LAUNCH_PROBE_MAX_MS =
  CONNECT_BACKOFF_MS.reduce((total, wait) => total + wait, 0) + CONNECT_BACKOFF_MS.length * PROBE_MAX_MS;
const IDENTITY_CHECKS_PER_RECOVERY = 4;
const RECOVERY_MAX_MS_EXCLUDING_KILL_GRACE =
  SHUTDOWN_REQUEST_MAX_MS +
  IDENTITY_CHECKS_PER_RECOVERY * READ_PROCESS_INFO_MAX_MS +
  TASKKILL_TIMEOUT_MS +
  TERMINATED_DAEMON_EXIT_WAIT_MS +
  LAUNCH_PROBE_MAX_MS;

export class DaemonUnreachableError extends Error {
  constructor() {
    super("daemon did not become reachable within timeout");
    this.name = "DaemonUnreachableError";
  }
}

export type UnresponsiveReason = "unconfirmed" | "survived" | "unrecorded";

export class DaemonUnresponsiveError extends Error {
  constructor(
    readonly reason: UnresponsiveReason,
    socketPath: string,
    readonly pid: number | null,
  ) {
    super(unresponsiveMessage(reason, socketPath, pid));
    this.name = "DaemonUnresponsiveError";
  }
}

function unresponsiveMessage(reason: UnresponsiveReason, socketPath: string, pid: number | null): string {
  const stop = `run \`${APP_NAME} daemon stop\``;
  switch (reason) {
    case "unconfirmed":
      return `daemon at ${socketPath} does not respond, and process ${pid} could not be confirmed as a ${APP_NAME} daemon, so it was left running; ${stop} to stop it`;
    case "survived":
      return `daemon process ${pid} at ${socketPath} does not respond and could not be stopped; ${stop}, or kill it manually`;
    case "unrecorded":
      return `something accepts connections at ${socketPath} without responding, and no daemon process is recorded for it; stop the process holding that socket, then retry`;
  }
}

export class DaemonRefusesBridgeError extends Error {
  constructor(status: DaemonStatus) {
    super(
      `the running daemon (${APP_NAME} ${daemonVersionLabel(status)}) no longer accepts bridges from ${APP_NAME} ${APP_VERSION}; ` +
        `upgrade ${APP_NAME}`,
    );
    this.name = "DaemonRefusesBridgeError";
  }
}

export class DaemonTooOldError extends Error {
  constructor(status: DaemonStatus) {
    super(
      `the running daemon (${APP_NAME} ${daemonVersionLabel(status)}) speaks a protocol too old for this bridge (${APP_NAME} ${APP_VERSION}) ` +
        `and could not be replaced; run \`${APP_NAME} daemon stop\`, then try again`,
    );
    this.name = "DaemonTooOldError";
  }
}

export interface EnsureAttemptOptions {
  freshAttempt?: boolean;
}

export interface EnsureDaemonOptions extends EnsureAttemptOptions {
  socketPath?: string;
  launch?: DaemonLauncher;
  logger?: Logger;
  _startingDaemonWaitMs?: number;
}

interface Bootstrap {
  socketPath: string;
  files: DaemonFiles;
  waitMs: number;
  launch: DaemonLauncher;
  daemonShutdownWaitMs: number;
}

interface PendingEnsure {
  promise: Promise<void>;
  fresh: boolean;
}

const pendingEnsures = new Map<string, PendingEnsure>();
const replacementAttempted = new Set<string>();
const lastWarnedOlderDaemonPid = new Map<string, number | null>();

export function ensureDaemonRunning(opts: EnsureDaemonOptions = {}): Promise<void> {
  const socketPath = opts.socketPath ?? getDaemonSocketPath();
  const fresh = opts.freshAttempt ?? false;
  const pending = pendingEnsures.get(socketPath);
  if (pending && (pending.fresh || !fresh)) return pending.promise;
  const attempt: PendingEnsure = { fresh, promise: Promise.resolve() };
  const previous = pending?.promise.catch(() => {}) ?? Promise.resolve();
  attempt.promise = previous
    .then(() => probeOrLaunch(socketPath, opts))
    .finally(() => {
      if (pendingEnsures.get(socketPath) === attempt) pendingEnsures.delete(socketPath);
    });
  pendingEnsures.set(socketPath, attempt);
  return attempt.promise;
}

async function probeOrLaunch(socketPath: string, opts: EnsureDaemonOptions): Promise<void> {
  const logger = opts.logger ?? createNoopLogger();
  let boot: Bootstrap | undefined;
  let launched = false;
  let waitedOut: DaemonProcess | null = null;

  for (;;) {
    const answering = await daemonStatus(socketPath);
    if (answering !== null) {
      const fit = daemonFit(answering);
      if (fit === "current") return;
      if (fit === "refuses-bridge") throw new DaemonRefusesBridgeError(answering);
      if (replacementAttempted.has(socketPath)) {
        if (fit === "too-old") throw new DaemonTooOldError(answering);
        warnAboutOlderDaemon(socketPath, answering, logger);
        return;
      }
      replacementAttempted.add(socketPath);
      boot ??= await bootstrapFor(socketPath, opts);
      if ((await replaceOutdatedDaemon(boot)) === "launched") launched = true;
      continue;
    }
    boot ??= await bootstrapFor(socketPath, opts);
    if (waitedOut !== null && (await recoveryInProgress(boot))) {
      await delay(DAEMON_POLL_MS);
      continue;
    }
    const daemon = await recordedDaemon(boot.files);
    if (daemon === null) {
      if (await recoveryInProgress(boot)) {
        await delay(DAEMON_POLL_MS);
        continue;
      }
      if (launched) throw new DaemonUnreachableError();
      if (await isServing(socketPath)) {
        await waitForUnrecordedServer(boot);
        continue;
      }
      launched = true;
      await launchAndWait(boot);
      continue;
    }
    if (waitedOut === null || !isSameProcess(waitedOut, daemon)) {
      if (await waitUntilStartedOrReplaced(boot, daemon)) continue;
      waitedOut = daemon;
    }
    if (launched) throw new DaemonUnreachableError();
    const recovery = await recoverWedgedDaemon(boot, daemon);
    if (recovery === "launched") launched = true;
    if (recovery === "busy") await delay(DAEMON_POLL_MS);
  }
}

async function bootstrapFor(socketPath: string, opts: EnsureDaemonOptions): Promise<Bootstrap> {
  return {
    socketPath,
    files: daemonFilesFor(socketPath),
    waitMs: opts._startingDaemonWaitMs ?? STARTING_DAEMON_WAIT_MS,
    launch: opts.launch ?? (await detachedDaemonLauncher()),
    daemonShutdownWaitMs: await loadDaemonShutdownWaitMs(),
  };
}

async function recordedDaemon(files: DaemonFiles): Promise<DaemonProcess | null> {
  for (const pid of await recordedPids(files)) {
    if (pid === process.pid) {
      if (await holdsLock(files.lockPath)) return describeProcess(pid);
      continue;
    }
    const snapshot = await describeProcess(pid);
    if (snapshot !== null && identityOf(snapshot) !== "foreign") return snapshot;
  }
  return null;
}

async function launchAndWait(boot: Bootstrap): Promise<void> {
  await boot.launch({});
  await waitForLaunchedDaemon(boot);
}

async function waitForLaunchedDaemon(boot: Bootstrap): Promise<void> {
  for (const wait of CONNECT_BACKOFF_MS) {
    await delay(wait);
    if (await isDaemonReachable(boot.socketPath)) return;
  }
}

async function waitUntilStartedOrReplaced(boot: Bootstrap, daemon: DaemonProcess): Promise<boolean> {
  const deadline = Date.now() + boot.waitMs;
  for (;;) {
    await delay(Math.min(DAEMON_POLL_MS, boot.waitMs));
    if (await isDaemonReachable(boot.socketPath)) return true;
    if (!(await recordedPids(boot.files)).includes(daemon.pid)) return true;
    if (Date.now() >= deadline) return false;
  }
}

async function waitForUnrecordedServer(boot: Bootstrap): Promise<void> {
  const deadline = Date.now() + boot.waitMs;
  while (Date.now() < deadline) {
    await delay(Math.min(DAEMON_POLL_MS, boot.waitMs));
    if (await isDaemonReachable(boot.socketPath)) return;
    if ((await recordedDaemon(boot.files)) !== null || !(await isServing(boot.socketPath))) return;
  }
  throw new DaemonUnresponsiveError("unrecorded", boot.socketPath, null);
}

async function replaceOutdatedDaemon(boot: Bootstrap): Promise<"resolved" | "launched"> {
  for (;;) {
    const guard = await tryAcquire(boot);
    if (guard === null) {
      await waitForOtherReplacement(boot);
      if (!(await isStillOutdated(boot.socketPath))) return "resolved";
      await delay(REPLACEMENT_POLL_MS);
      continue;
    }
    try {
      if (!(await isStillOutdated(boot.socketPath))) return "resolved";
      const daemon = await recordedDaemon(boot.files);
      return daemon === null ? await replaceUnrecordedDaemon(boot) : await replaceRecordedDaemon(boot, daemon);
    } finally {
      await guard.release().catch(() => {});
    }
  }
}

async function waitForOtherReplacement(boot: Bootstrap): Promise<void> {
  while (await recoveryInProgress(boot)) {
    const status = await daemonStatus(boot.socketPath);
    if (status !== null && !isOutdatedDaemon(status)) return;
    await delay(REPLACEMENT_POLL_MS);
  }
}

async function isStillOutdated(socketPath: string): Promise<boolean> {
  const status = await daemonStatus(socketPath);
  return status !== null && isOutdatedDaemon(status);
}

async function replaceRecordedDaemon(boot: Bootstrap, daemon: DaemonProcess): Promise<"resolved" | "launched"> {
  switch (await boot.launch({ awaitPredecessorMs: predecessorWaitMs(boot) })) {
    case "waiting":
      if (!(await stopPredecessor(boot, daemon))) return "resolved";
      break;
    case "serving":
      break;
    default:
      return "resolved";
  }
  await waitForLaunchedDaemon(boot);
  return "launched";
}

async function stopPredecessor(boot: Bootstrap, daemon: DaemonProcess): Promise<boolean> {
  await requestShutdown(boot.socketPath, (status) => status.pid === daemon.pid);
  if (await waitForExit(daemon.pid, boot.daemonShutdownWaitMs)) return true;
  const stop = await terminateDaemon(daemon.pid, { graceMs: boot.daemonShutdownWaitMs, startTime: daemon.startTime });
  if (stop !== "terminated") return false;
  return waitForExit(daemon.pid, TERMINATED_DAEMON_EXIT_WAIT_MS);
}

async function replaceUnrecordedDaemon(boot: Bootstrap): Promise<"resolved" | "launched"> {
  const asked = await requestShutdown(boot.socketPath, (status) => isOutdatedDaemon(status));
  if (!asked) return "resolved";
  if (!(await stopsServing(boot.socketPath, boot.daemonShutdownWaitMs))) return "resolved";
  await launchAndWait(boot);
  return "launched";
}

async function stopsServing(socketPath: string, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (await isServing(socketPath)) {
    if (Date.now() >= deadline) return false;
    await delay(REPLACEMENT_POLL_MS);
  }
  return true;
}

function predecessorWaitMs(boot: Bootstrap): number {
  const needed = SHUTDOWN_REQUEST_MAX_MS + 2 * boot.daemonShutdownWaitMs + TERMINATED_DAEMON_EXIT_WAIT_MS + 2 * READ_PROCESS_INFO_MAX_MS;
  return Math.min(needed, MAX_AWAIT_PREDECESSOR_MS);
}

function warnAboutOlderDaemon(socketPath: string, status: DaemonStatus, logger: Logger): void {
  const pid = reportedDaemonPid(status);
  if (lastWarnedOlderDaemonPid.get(socketPath) === pid) return;
  lastWarnedOlderDaemonPid.set(socketPath, pid);
  logger.warn(
    `${olderDaemonStillRunning(status)} after an attempt to replace it; this bridge (${APP_VERSION}) will use it`,
    { component: "daemon" },
  );
}

async function requestShutdown(socketPath: string, isDaemonToStop: (status: DaemonStatus) => boolean): Promise<boolean> {
  const client = probeClient(socketPath);
  try {
    await client.connect();
    const status = asDaemonStatus(await client.call("STATUS"));
    if (status === null || !isDaemonToStop(status)) return false;
    await client.call("SHUTDOWN").catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

async function recoverWedgedDaemon(
  boot: Bootstrap,
  daemon: DaemonProcess,
): Promise<"busy" | "resolved" | "launched"> {
  const guard = await tryAcquire(boot);
  if (guard === null) return "busy";
  try {
    if (await isDaemonReachable(boot.socketPath)) return "resolved";
    const current = await recordedDaemon(boot.files);
    if (current === null || !isSameProcess(current, daemon)) return "resolved";
    const result = await terminateDaemon(daemon.pid, {
      graceMs: boot.daemonShutdownWaitMs,
      startTime: daemon.startTime,
    });
    if (result === "not_ours") {
      throw new DaemonUnresponsiveError("unconfirmed", boot.socketPath, daemon.pid);
    }
    if (result === "failed" || !(await waitForExit(daemon.pid, TERMINATED_DAEMON_EXIT_WAIT_MS))) {
      throw new DaemonUnresponsiveError("survived", boot.socketPath, daemon.pid);
    }
    await launchAndWait(boot);
    return "launched";
  } finally {
    await guard.release().catch(() => {});
  }
}

function recoveryGuardPath(boot: Bootstrap): string {
  return `${boot.files.lockPath}.recover`;
}

async function recoveryInProgress(boot: Bootstrap): Promise<boolean> {
  const guardPath = recoveryGuardPath(boot);
  if (await holdsLock(guardPath)) return false;
  return isLockLive(guardPath, { maxAgeMs: recoveryGuardMaxAgeMs(boot), isProcessAlive: isOtherLiveProcess });
}

function isOtherLiveProcess(pid: number): boolean {
  return pid !== process.pid && processExists(pid);
}

function recoveryGuardMaxAgeMs(boot: Bootstrap): number {
  return 2 * (SUCCESSOR_REPORT_TIMEOUT_MS + RECOVERY_MAX_MS_EXCLUDING_KILL_GRACE + 2 * boot.daemonShutdownWaitMs);
}

async function tryAcquire(boot: Bootstrap): Promise<LockHandle | null> {
  try {
    return await acquireLock(recoveryGuardPath(boot), {
      stealStale: true,
      maxAgeMs: recoveryGuardMaxAgeMs(boot),
      isProcessAlive: isOtherLiveProcess,
      track: true,
    });
  } catch (err) {
    if (err instanceof LockBusyError) return null;
    throw err;
  }
}

function probeClient(socketPath: string): DaemonClient {
  return new DaemonClient({
    socketPath,
    transport: netTransport,
    rpcTimeoutMs: PROBE_TIMEOUT_MS,
    connectTimeoutMs: PROBE_TIMEOUT_MS,
  });
}

function asDaemonStatus(reply: unknown): DaemonStatus | null {
  return typeof reply === "object" && reply !== null ? (reply as DaemonStatus) : null;
}

export async function daemonStatus(socketPath: string): Promise<DaemonStatus | null> {
  const client = probeClient(socketPath);
  try {
    await client.connect();
    return asDaemonStatus(await client.call("STATUS"));
  } catch (err) {
    if (isSocketAddressError(err)) throw err;
    return null;
  } finally {
    client.close();
  }
}

export async function isDaemonReachable(socketPath: string): Promise<boolean> {
  return (await daemonStatus(socketPath)) !== null;
}
