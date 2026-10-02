import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "./client.js";
import { getDaemonSocketPath } from "./paths.js";
import { isServing, netTransport } from "./net-transport.js";
import { DAEMON_LAUNCH_ARGS } from "./daemon-identity.js";

/**
 * Backoff schedule for "wait for daemon to be reachable after spawn".
 * Cumulative: ~2.75 s. The daemon answers once it has reaped leaked
 * children; while its socket accepts connections but it hasn't answered yet,
 * probing continues for up to STARTING_DAEMON_WAIT_MS.
 */
const CONNECT_BACKOFF_MS = [50, 200, 500, 1000, 1000] as const;
const STARTING_DAEMON_WAIT_MS = 60_000;
const STARTING_DAEMON_POLL_MS = 1_000;

export interface EnsureAttemptOptions {
  freshAttempt?: boolean;
}

export interface EnsureDaemonOptions extends EnsureAttemptOptions {
  socketPath?: string;
  launch?: () => void;
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

  const launch = opts.launch ?? (await detachedDaemonLauncher());
  launch();

  for (const wait of CONNECT_BACKOFF_MS) {
    await delay(wait);
    if (await isDaemonReachable(socketPath)) return;
  }

  const deadline = Date.now() + STARTING_DAEMON_WAIT_MS;
  while (Date.now() < deadline && (await isServing(socketPath))) {
    if (await isDaemonReachable(socketPath)) return;
    await delay(STARTING_DAEMON_POLL_MS);
  }

  throw new Error("daemon did not become reachable within timeout");
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
    rpcTimeoutMs: 1_000,
    connectTimeoutMs: 1_000,
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
