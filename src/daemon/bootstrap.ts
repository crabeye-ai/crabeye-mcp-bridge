import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "./client.js";
import { daemonFilesFor, getDaemonSocketPath, type DaemonFiles } from "./paths.js";
import { isServing, netTransport } from "./net-transport.js";
import { DAEMON_LAUNCH_ARGS } from "./daemon-identity.js";
import {
  describeProcess,
  identityOf,
  isSameProcess,
  recordedPids,
  terminateDaemon,
  waitForExit,
  type DaemonProcess,
} from "./daemon-process.js";
import { acquireLock, holdsLock, isLockLive, LockBusyError, type LockHandle } from "./lockfile.js";
import { APP_NAME } from "../constants.js";
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
const WEDGED_DAEMON_EXIT_WAIT_MS = 5_000;
const PROBE_MAX_MS = 2 * PROBE_TIMEOUT_MS;
const LAUNCH_PROBE_MAX_MS =
  CONNECT_BACKOFF_MS.reduce((total, wait) => total + wait, 0) + CONNECT_BACKOFF_MS.length * PROBE_MAX_MS;
const IDENTITY_CHECKS_PER_RECOVERY = 4;
const RECOVERY_MAX_MS_EXCLUDING_KILL_GRACE =
  PROBE_MAX_MS +
  IDENTITY_CHECKS_PER_RECOVERY * READ_PROCESS_INFO_MAX_MS +
  TASKKILL_TIMEOUT_MS +
  WEDGED_DAEMON_EXIT_WAIT_MS +
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

export interface EnsureAttemptOptions {
  freshAttempt?: boolean;
}

export interface EnsureDaemonOptions extends EnsureAttemptOptions {
  socketPath?: string;
  launch?: () => void;
  _startingDaemonWaitMs?: number;
}

interface Bootstrap {
  socketPath: string;
  files: DaemonFiles;
  waitMs: number;
  launch: () => void;
  wedgedDaemonStopWaitMs: number;
}

interface PendingEnsure {
  promise: Promise<void>;
  fresh: boolean;
}

const pendingEnsures = new Map<string, PendingEnsure>();

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
  if (await isDaemonReachable(socketPath)) return;
  const boot: Bootstrap = {
    socketPath,
    files: daemonFilesFor(socketPath),
    waitMs: opts._startingDaemonWaitMs ?? STARTING_DAEMON_WAIT_MS,
    launch: opts.launch ?? (await detachedDaemonLauncher()),
    wedgedDaemonStopWaitMs: await loadDaemonShutdownWaitMs(),
  };
  let launched = false;
  let waitedOut: DaemonProcess | null = null;

  for (;;) {
    if (await isDaemonReachable(socketPath)) return;
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
      if (await launchAndProbe(boot)) return;
      continue;
    }
    if (waitedOut === null || !isSameProcess(waitedOut, daemon)) {
      const outcome = await waitWhileStarting(boot, daemon);
      if (outcome === "ready") return;
      if (outcome === "replaced") continue;
      waitedOut = daemon;
    }
    if (launched) throw new DaemonUnreachableError();
    const recovery = await recoverWedgedDaemon(boot, daemon);
    if (recovery === "launched") launched = true;
    if (recovery === "busy") await delay(DAEMON_POLL_MS);
  }
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

async function launchAndProbe(boot: Bootstrap): Promise<boolean> {
  boot.launch();
  for (const wait of CONNECT_BACKOFF_MS) {
    await delay(wait);
    if (await isDaemonReachable(boot.socketPath)) return true;
  }
  return false;
}

async function waitWhileStarting(
  boot: Bootstrap,
  daemon: DaemonProcess,
): Promise<"ready" | "replaced" | "expired"> {
  const deadline = Date.now() + boot.waitMs;
  for (;;) {
    await delay(Math.min(DAEMON_POLL_MS, boot.waitMs));
    if (await isDaemonReachable(boot.socketPath)) return "ready";
    if (!(await recordedPids(boot.files)).includes(daemon.pid)) return "replaced";
    if (Date.now() >= deadline) return "expired";
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
      graceMs: boot.wedgedDaemonStopWaitMs,
      startTime: daemon.startTime,
    });
    if (result === "not_ours") {
      throw new DaemonUnresponsiveError("unconfirmed", boot.socketPath, daemon.pid);
    }
    if (result === "failed" || !(await waitForExit(daemon.pid, WEDGED_DAEMON_EXIT_WAIT_MS))) {
      throw new DaemonUnresponsiveError("survived", boot.socketPath, daemon.pid);
    }
    await launchAndProbe(boot);
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
  return 2 * (RECOVERY_MAX_MS_EXCLUDING_KILL_GRACE + boot.wedgedDaemonStopWaitMs);
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

async function detachedDaemonLauncher(): Promise<() => void> {
  const entry = await resolveEntryScript();
  return () => {
    const child = spawn(process.execPath, [entry, ...DAEMON_LAUNCH_ARGS], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    child.on("error", () => {});
  };
}

export async function isDaemonReachable(socketPath: string): Promise<boolean> {
  const client = new DaemonClient({
    socketPath,
    transport: netTransport,
    rpcTimeoutMs: PROBE_TIMEOUT_MS,
    connectTimeoutMs: PROBE_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.call("STATUS");
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

/**
 * Find the CLI entry script to self-spawn the daemon. Prefers the bundled
 * `index.js` next to this module so an attacker can't redirect us by
 * substituting argv[1].
 */
export async function resolveEntryScript(): Promise<string> {
  const here = fileURLToPath(import.meta.url);
  const sibling = join(dirname(here), "index.js");
  try {
    if ((await stat(sibling)).isFile()) return sibling;
  } catch {
    /* fall through */
  }
  const argv1 = process.argv[1];
  if (!argv1) {
    throw new Error("cannot self-spawn daemon: no entry script could be resolved");
  }
  // The sibling-first probe failed (dev shells, ts-node, atypical install
  // layouts). Falling back to argv[1] is convenient but argv[1] is
  // attacker-trivial to manipulate (wrappers, aliases). Make the fallback
  // visible so an unexpected layout doesn't silently widen the trust
  // boundary.
  process.stderr.write(
    `warning: daemon self-spawn falling back to argv[1] (${argv1}); install layout missing sibling index.js\n`,
  );
  return argv1;
}
