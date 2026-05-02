import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 100;
const PS_TIMEOUT_MS = 2000;
const POWERSHELL_TIMEOUT_MS = 5000;
const TASKKILL_TIMEOUT_MS = 5000;

export interface KillProcessTreeOptions {
  /** Time to wait after the graceful signal before escalating to force-kill. */
  gracefulMs?: number;
  /** Time to wait after the force-kill before giving up. */
  forceMs?: number;
  /** Polling interval for aliveness checks. */
  pollMs?: number;
}

export interface ProcessInfo {
  cmdline: string;
  /** ms since epoch; null when the platform query did not yield a value. */
  startTime: number | null;
}

/**
 * Send `process.kill(pid, 0)` to test whether the process exists and we can
 * signal it. Works on POSIX and Windows.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill `pid` and any descendants. POSIX uses two-phase process-group SIGTERM →
 * SIGKILL; Windows uses `taskkill /T` followed by `taskkill /T /F`.
 *
 * Returns true once the process is no longer alive.
 */
export async function killProcessTree(
  pid: number,
  options: KillProcessTreeOptions = {},
): Promise<boolean> {
  const gracefulMs = options.gracefulMs ?? 5000;
  const forceMs = options.forceMs ?? 2000;
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS;

  if (!isProcessAlive(pid)) return true;

  if (process.platform === "win32") {
    await runTaskkill(pid, false).catch(() => {});
    if (await waitForExit(pid, gracefulMs, pollMs)) return true;
    await runTaskkill(pid, true).catch(() => {});
    await waitForExit(pid, forceMs, pollMs);
    return !isProcessAlive(pid);
  }

  // POSIX: process group first (catches grandchildren when the child was
  // spawned with detached:true), fall through to single PID otherwise.
  sendPosixSignal(pid, "SIGTERM");
  if (await waitForExit(pid, gracefulMs, pollMs)) return true;

  sendPosixSignal(pid, "SIGKILL");
  await waitForExit(pid, forceMs, pollMs);
  return !isProcessAlive(pid);
}

/**
 * Read the live process command line and start time. Returns null when the
 * process is gone or the platform query failed.
 *
 * The start time is reported in ms since the Unix epoch; null indicates the
 * value was unavailable (caller should treat the process as a possible match
 * to err on the side of cleanup).
 */
export async function readProcessInfo(pid: number): Promise<ProcessInfo | null> {
  if (process.platform === "win32") {
    return readWindowsProcessInfo(pid);
  }
  if (process.platform === "linux") {
    return readLinuxProcessInfo(pid);
  }
  return readPosixProcessInfo(pid);
}

// --- POSIX helpers ---

function sendPosixSignal(pid: number, signal: NodeJS.Signals): boolean {
  // Try the process group first. Catches grandchildren when the child was
  // spawned with detached:true. Falls through silently when no group has
  // PGID=pid (the common case for MCP servers spawned without detached).
  let groupHit = false;
  try {
    process.kill(-pid, signal);
    groupHit = true;
  } catch {
    // ESRCH: no group with that PGID. Nothing to do for the group; signal
    // the direct PID below. Other errors (EPERM): also fall through.
  }

  // Always try the direct PID too. The group kill may have already terminated
  // it, in which case the second call returns ESRCH harmlessly. If the group
  // kill missed (no such group), this is the only signal that lands.
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return groupHit; // gone
    return false;
  }
}

async function readLinuxProcessInfo(pid: number): Promise<ProcessInfo | null> {
  let cmdline: string;
  try {
    const buf = await readFile(`/proc/${pid}/cmdline`);
    cmdline = buf.toString("utf-8").replace(/\0+$/, "").replace(/\0/g, " ");
  } catch {
    return null;
  }

  let startTime: number | null = null;
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      { timeout: PS_TIMEOUT_MS },
    );
    const parsed = Date.parse(stdout.trim());
    startTime = Number.isNaN(parsed) ? null : parsed;
  } catch {
    startTime = null;
  }

  return { cmdline, startTime };
}

async function readPosixProcessInfo(pid: number): Promise<ProcessInfo | null> {
  // macOS / BSD: one ps call for both fields. lstart is fixed-width (24
  // chars: "Sat May  2 18:31:41 2026"), with the command following.
  let raw: string;
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "lstart=,command="],
      { timeout: PS_TIMEOUT_MS },
    );
    raw = stdout.trimEnd();
  } catch {
    return null;
  }
  if (!raw) return null;

  // lstart format is exactly 24 chars on BSD/macOS ps. Take everything after
  // the first space-run starting at position 24. Be lenient about extra
  // whitespace introduced by month padding.
  const match = raw.match(/^(.{24})\s+(.+)$/);
  if (!match) {
    // Fallback: split by ≥2 spaces (lstart and command separated)
    const parts = raw.split(/\s{2,}/);
    if (parts.length < 2) return { cmdline: raw, startTime: null };
    const parsed = Date.parse(parts[0]!);
    return {
      cmdline: parts.slice(1).join(" "),
      startTime: Number.isNaN(parsed) ? null : parsed,
    };
  }
  const parsed = Date.parse(match[1]!);
  return {
    cmdline: match[2]!,
    startTime: Number.isNaN(parsed) ? null : parsed,
  };
}

// --- Windows helpers ---

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  await execFileAsync("taskkill", args, { timeout: TASKKILL_TIMEOUT_MS });
}

async function readWindowsProcessInfo(pid: number): Promise<ProcessInfo | null> {
  // Use a single PowerShell call to fetch CreationDate and CommandLine.
  // CreationDate is a CIM datetime; ToFileTimeUtc returns 100-ns intervals
  // since 1601-01-01 UTC, which we convert to Unix ms below.
  const script = [
    `$ErrorActionPreference = 'Stop';`,
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";`,
    `if ($null -eq $p) { exit 1 }`,
    `Write-Output $p.CreationDate.ToFileTimeUtc();`,
    `Write-Output $p.CommandLine`,
  ].join(" ");
  let stdout: string;
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true },
    );
    stdout = result.stdout;
  } catch {
    return null;
  }

  const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  // FILETIME 100-ns intervals since 1601-01-01 UTC.
  // Unix epoch is 11644473600 seconds after that.
  const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n;
  let startTime: number | null = null;
  try {
    const filetime = BigInt(lines[0]!.trim());
    const ms = filetime / 10_000n - FILETIME_EPOCH_OFFSET_MS;
    startTime = Number(ms);
  } catch {
    startTime = null;
  }

  return {
    cmdline: (lines[1] ?? "").trim(),
    startTime,
  };
}

// --- Shared ---

async function waitForExit(
  pid: number,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  if (timeoutMs <= 0) return !isProcessAlive(pid);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(pollMs);
  }
  return !isProcessAlive(pid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
