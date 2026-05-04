import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "./client.js";
import { getDaemonSocketPath } from "./paths.js";
import { netTransport } from "./net-transport.js";

/**
 * Backoff schedule for "wait for daemon to be reachable after spawn".
 * Cumulative: ~2.75 s. Daemon binds the IPC socket synchronously after the
 * lockfile and pidfile, so first or second probe usually wins.
 */
const CONNECT_BACKOFF_MS = [50, 200, 500, 1000, 1000] as const;

/**
 * Probe + spawn-on-miss. Tries the daemon socket; if unreachable, spawns the
 * detached daemon process and polls until it answers STATUS or the backoff
 * exhausts. Concurrent bridges that race here lose the lock contest inside
 * `runDaemonInternal` and harmlessly fall through to the survivor.
 */
export async function ensureDaemonRunning(opts: {
  socketPath?: string;
  /** Override for tests: skip the actual spawn. */
  spawnEntry?: string;
} = {}): Promise<void> {
  const socketPath = opts.socketPath ?? getDaemonSocketPath();
  if (await isReachable(socketPath)) return;

  const entry = opts.spawnEntry ?? (await resolveEntryScript());
  const child = spawn(process.execPath, [entry, "daemon", "--internal-launch"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
  child.on("error", () => {
    /* surfaced by the unreachable-after-backoff path below */
  });

  for (const wait of CONNECT_BACKOFF_MS) {
    await delay(wait);
    if (await isReachable(socketPath)) return;
  }

  throw new Error("daemon did not become reachable within timeout");
}

async function isReachable(socketPath: string): Promise<boolean> {
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
