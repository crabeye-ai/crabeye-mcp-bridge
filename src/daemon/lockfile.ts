import { open, readFile, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";

/**
 * Cross-platform exclusive-create lockfile.
 *
 * `acquire()` succeeds only when the lockfile does not already exist; the
 * returned handle owns the file until `release()` (or process exit).
 *
 * On Unix this is `O_CREAT | O_EXCL | O_WRONLY` — atomic per POSIX. On
 * Windows, the same flag combination on Node's `fs` translates to a
 * `CreateFile(CREATE_NEW, FILE_SHARE_NONE)` which is also atomic.
 *
 * The held handle keeps an OS file descriptor open for the daemon's lifetime;
 * if the daemon crashes the OS releases the fd, but the on-disk file remains.
 * `acquire({ stealStale })` therefore probes a stale lock by checking whether
 * the recorded pid is alive and unlinks if not.
 */
export class LockHandle {
  constructor(
    public readonly path: string,
    private fh: FileHandle | null,
  ) {}

  async release(): Promise<void> {
    if (this.fh === null) return;
    const fh = this.fh;
    this.fh = null;
    try {
      await fh.close();
    } catch {
      /* ignore */
    }
    try {
      await unlink(this.path);
    } catch {
      /* ignore — best-effort cleanup */
    }
  }
}

export interface AcquireOptions {
  /** Write this pid into the lockfile body for diagnostics + stale-detection. */
  pid?: number;
  /**
   * If acquire fails with EEXIST, read the recorded pid; if that process is
   * not alive, unlink and retry once. Default: true.
   */
  stealStale?: boolean;
  /** Override for tests: probes whether a pid is alive. */
  isProcessAlive?: (pid: number) => boolean;
}

export class LockBusyError extends Error {
  constructor(public readonly path: string, public readonly heldByPid: number | null) {
    super(
      heldByPid !== null
        ? `lock ${path} held by pid ${heldByPid}`
        : `lock ${path} is held`,
    );
    this.name = "LockBusyError";
  }
}

export async function acquireLock(
  path: string,
  opts: AcquireOptions = {},
): Promise<LockHandle> {
  const pid = opts.pid ?? process.pid;
  const stealStale = opts.stealStale ?? true;
  const isAlive = opts.isProcessAlive ?? defaultIsProcessAlive;

  try {
    return await openExclusive(path, pid);
  } catch (err) {
    if (!isEexist(err)) throw err;

    if (!stealStale) {
      throw new LockBusyError(path, await readPidSafe(path));
    }

    const heldBy = await readPidSafe(path);
    if (heldBy !== null && isAlive(heldBy)) {
      throw new LockBusyError(path, heldBy);
    }

    // Stale: holder is dead (or pid unreadable). Unlink and retry once. If we
    // race with a concurrent acquirer, our second attempt will fail with
    // EEXIST and we surface LockBusyError.
    try {
      await unlink(path);
    } catch (unlinkErr) {
      if (!isEnoent(unlinkErr)) throw unlinkErr;
    }
    try {
      return await openExclusive(path, pid);
    } catch (err2) {
      if (isEexist(err2)) {
        throw new LockBusyError(path, await readPidSafe(path));
      }
      throw err2;
    }
  }
}

async function openExclusive(path: string, pid: number): Promise<LockHandle> {
  const fh = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  await fh.writeFile(`${pid}\n`, "utf-8");
  return new LockHandle(path, fh);
}

async function readPidSafe(path: string): Promise<number | null> {
  try {
    const txt = await readFile(path, "utf-8");
    const n = Number.parseInt(txt.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we lack permission — still "alive".
    return code === "EPERM";
  }
}

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EEXIST";
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}
