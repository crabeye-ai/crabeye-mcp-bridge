import { execFileSync, spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
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

export function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

export function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid;
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

export interface LineProcess {
  child: ChildProcessWithoutNullStreams;
  line: () => Promise<string>;
}

export function startLineProcess(
  children: ChildProcessWithoutNullStreams[],
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): LineProcess {
  const child = spawn(process.execPath, [script, ...args], { stdio: "pipe", env });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const line = async () => {
    const next = await lines.next();
    if (next.done) throw new Error(`process ${child.pid} exited without output; stderr: ${stderr}`);
    return next.value;
  };
  return { child, line };
}

export async function awaitHeld(holder: LineProcess): Promise<LineProcess> {
  const first = await holder.line();
  if (first !== "held") throw new Error(`lock holder said "${first}" instead of "held"`);
  return holder;
}

export async function killAll(children: ChildProcessWithoutNullStreams[]): Promise<void> {
  const leftovers = children.splice(0);
  for (const child of leftovers) child.kill("SIGKILL");
  await Promise.all(leftovers.map((child) => exited(child, 5_000)));
}
