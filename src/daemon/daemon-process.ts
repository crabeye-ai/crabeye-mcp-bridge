import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parsePid, processExists, readProcessInfo, TASKKILL_TIMEOUT_MS } from "../process/process-utils.js";
import { isDaemonCommandLine } from "./daemon-identity.js";
import { readLockHolderPid } from "./lockfile.js";
import type { DaemonFiles } from "./paths.js";

const EXIT_POLL_MS = 50;

export interface DaemonProcess {
  pid: number;
  startTime: number | null;
}

export interface ProcessSnapshot extends DaemonProcess {
  cmdline: string | null;
}

export type ProcessIdentity = "daemon" | "foreign" | "unknown";

export type TerminateResult = "terminated" | "not_ours" | "failed";

export interface TerminateOptions {
  graceMs: number;
  allowUnidentified?: boolean;
  startTime?: number | null;
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(EXIT_POLL_MS);
  }
  return true;
}

export async function readPidFile(path: string): Promise<number | null> {
  try {
    return parsePid(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

export async function recordedPids(files: DaemonFiles): Promise<number[]> {
  const pids = [await readLockHolderPid(files.lockPath), await readPidFile(files.pidPath)];
  return [...new Set(pids)].filter((pid): pid is number => pid !== null && processExists(pid));
}

export async function describeProcess(pid: number): Promise<ProcessSnapshot | null> {
  if (!processExists(pid)) return null;
  const info = await readProcessInfo(pid);
  const cmdline = info !== null && info.cmdline.trim() !== "" ? info.cmdline : null;
  return { pid, startTime: info?.startTime ?? null, cmdline };
}

export function identityOf(snapshot: ProcessSnapshot): ProcessIdentity {
  if (snapshot.cmdline === null) return "unknown";
  return isDaemonCommandLine(snapshot.cmdline) ? "daemon" : "foreign";
}

export function isSameProcess(a: DaemonProcess, b: DaemonProcess): boolean {
  if (a.pid !== b.pid) return false;
  return a.startTime === null || b.startTime === null || a.startTime === b.startTime;
}

export async function terminateDaemon(pid: number, opts: TerminateOptions): Promise<TerminateResult> {
  if (pid === process.pid) return "not_ours";
  const allowUnidentified = opts.allowUnidentified ?? false;
  const first = await describeProcess(pid);
  if (first === null) return "terminated";
  if (!isOurs(first, allowUnidentified, opts.startTime ?? null)) return "not_ours";
  if (process.platform === "win32") return (await taskkill(pid)) ? "terminated" : "failed";
  try {
    if (opts.graceMs > 0) {
      process.kill(pid, "SIGTERM");
      if (await waitForExit(pid, opts.graceMs)) return "terminated";
      const again = await describeProcess(pid);
      if (again === null) return "terminated";
      if (!isOurs(again, allowUnidentified, opts.startTime ?? first.startTime)) return "not_ours";
    }
    process.kill(pid, "SIGKILL");
    return "terminated";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? "terminated" : "failed";
  }
}

function isOurs(snapshot: ProcessSnapshot, allowUnidentified: boolean, startTime: number | null): boolean {
  if (!mayStop(identityOf(snapshot), allowUnidentified)) return false;
  return startTime === null || isSameProcess(snapshot, { pid: snapshot.pid, startTime });
}

function mayStop(identity: ProcessIdentity, allowUnidentified: boolean): boolean {
  return identity === "daemon" || (allowUnidentified && identity === "unknown");
}

function taskkill(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", timeout: TASKKILL_TIMEOUT_MS });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}
