import { execFileSync, type ChildProcess } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DAEMON_LAUNCH_ARGS } from "../../src/daemon/daemon-identity.js";

const REPO_CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

export function exited(child: ChildProcess, withinMs: number): Promise<number | null | "running"> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return Promise.race([
    new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))),
    new Promise<"running">((resolve) => setTimeout(() => resolve("running"), withinMs)),
  ]);
}

export async function waitUntil(condition: () => boolean, withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

export function signalIfRunning(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

/** Only for test-owned scripts: the repo's own `dist/index.js` may be running the user's real daemon. */
export function daemonPidsRunning(script: string): number[] {
  if (!isAbsolute(script) || resolve(script) === REPO_CLI) throw new Error(`refusing to match daemons by ${JSON.stringify(script)}`);
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf-8" })
    .split("\n")
    .filter((line) => line.includes(script) && line.includes(DAEMON_LAUNCH_ARGS.join(" ")))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}
