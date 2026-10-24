import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { basename, dirname, join } from "node:path";
import type { Logger } from "../logging/index.js";
import { sweepAbandonedLockFiles, waitForLock } from "../process/lockfile.js";
import { processExists } from "../process/process-utils.js";
import { warnSafely } from "./warn-safely.js";

const TEMP_INFIX = ".tmp.";
const PID_SUFFIX = /^\d+$/;
const WINDOWS_RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const MIN_RENAME_RETRY_MS = 5;
const MAX_RENAME_RETRY_MS = 100;

export interface StoreWriteLockOptions {
  giveUp: AbortSignal;
  logger?: Logger;
}

export function storeTempPath(storePath: string): string {
  return `${storePath}${TEMP_INFIX}${process.pid}`;
}

export async function withStoreWriteLock<T>(
  storePath: string,
  opts: StoreWriteLockOptions,
  body: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });
  const lockPath = `${storePath}.lock`;
  const handle = await waitForLock(lockPath, { signal: opts.giveUp });
  try {
    await sweepAbandonedLockFiles(lockPath);
    await removeDeadWriterTempFiles(storePath);
    opts.giveUp.throwIfAborted();
    return await body();
  } finally {
    await handle.release().catch((err: unknown) =>
      warnSafely(opts.logger, `Failed to release the credential store lock: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

export async function replaceStoreFile(tmpPath: string, storePath: string, giveUp: AbortSignal): Promise<void> {
  for (let backoffMs = MIN_RENAME_RETRY_MS; ; backoffMs = Math.min(backoffMs * 2, MAX_RENAME_RETRY_MS)) {
    giveUp.throwIfAborted();
    try {
      return await rename(tmpPath, storePath);
    } catch (err) {
      if (!isRetryableOnWindows(err)) throw err;
    }
    await delay(backoffMs, undefined, { signal: giveUp }).catch(() => {});
  }
}

function isRetryableOnWindows(err: unknown): boolean {
  return process.platform === "win32" && WINDOWS_RENAME_RETRY_CODES.has((err as NodeJS.ErrnoException).code ?? "");
}

async function removeDeadWriterTempFiles(storePath: string): Promise<void> {
  const dir = dirname(storePath);
  const prefix = `${basename(storePath)}${TEMP_INFIX}`;
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!PID_SUFFIX.test(suffix)) continue;
    const writer = Number(suffix);
    if (writer === process.pid || processExists(writer)) continue;
    await unlink(join(dir, name)).catch(() => {});
  }
}
