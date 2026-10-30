import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_LAUNCH_ARGS } from "./daemon-identity.js";

export const AWAIT_PREDECESSOR_FLAG = "--await-predecessor-ms";
export const MAX_AWAIT_PREDECESSOR_MS = 10 * 60_000;
export const SUCCESSOR_REPORT_TIMEOUT_MS = 10_000;

export type SuccessorReport = "waiting" | "serving";
export type LaunchOutcome = "launched" | SuccessorReport | "gone";

const REPORT_MESSAGES: Record<SuccessorReport, string> = {
  waiting: "awaiting-predecessor",
  serving: "serving-without-predecessor",
};

export interface LaunchOptions {
  awaitPredecessorMs?: number;
}

/**
 * A plain launch resolves "launched". With `awaitPredecessorMs`, resolves what the new daemon reports:
 * "waiting" while the daemon it replaces holds the lock or socket, "serving" when nothing was in its way,
 * or "gone" when it exits or stays silent first.
 */
export type DaemonLauncher = (opts: LaunchOptions) => Promise<LaunchOutcome>;

export async function detachedDaemonLauncher(entryScript?: string): Promise<DaemonLauncher> {
  const entry = entryScript ?? (await resolveEntryScript());
  return async ({ awaitPredecessorMs }) => {
    if (awaitPredecessorMs === undefined) {
      spawnDetachedDaemon(entry, [], "ignore");
      return "launched";
    }
    const child = spawnDetachedDaemon(entry, [AWAIT_PREDECESSOR_FLAG, String(awaitPredecessorMs)], ["ignore", "ignore", "ignore", "ipc"]);
    return successorReport(child);
  };
}

/**
 * The environment the daemon is launched with: the launcher's own, without
 * `NODE_OPTIONS`, whose TLS and proxy flags would otherwise apply to every
 * client's connections.
 */
export function daemonLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== "NODE_OPTIONS"));
}

function spawnDetachedDaemon(entry: string, extraArgs: string[], stdio: StdioOptions): ChildProcess {
  const child = spawn(process.execPath, [entry, ...DAEMON_LAUNCH_ARGS, ...extraArgs], {
    detached: true,
    stdio,
    env: daemonLaunchEnv(process.env),
  });
  child.unref();
  child.on("error", () => {});
  return child;
}

function parseReport(message: unknown): SuccessorReport | null {
  if (message === REPORT_MESSAGES.waiting) return "waiting";
  if (message === REPORT_MESSAGES.serving) return "serving";
  return null;
}

export function successorReport(child: ChildProcess, timeoutMs = SUCCESSOR_REPORT_TIMEOUT_MS): Promise<SuccessorReport | "gone"> {
  return new Promise((resolve) => {
    const settle = (outcome: SuccessorReport | "gone"): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onGone);
      child.off("error", onGone);
      if (child.connected) child.disconnect();
      resolve(outcome);
    };
    const onMessage = (message: unknown): void => {
      const report = parseReport(message);
      if (report !== null) settle(report);
    };
    const onGone = (): void => settle("gone");
    const timer = setTimeout(onGone, timeoutMs);
    child.on("message", onMessage);
    child.once("exit", onGone);
    child.once("error", onGone);
    child.channel?.unref();
  });
}

let reportedToLauncher = false;

/** Tells the bridge that launched this daemon how its start went; only the first report is sent. */
export function reportToLauncher(report: SuccessorReport): void {
  if (reportedToLauncher || process.send === undefined || !process.connected) return;
  reportedToLauncher = true;
  process.send(REPORT_MESSAGES[report], () => {
    if (process.connected) process.disconnect?.();
  });
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
