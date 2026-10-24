import { mkdir, readdir, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Logger } from "../logging/index.js";
import { sweepAbandonedLockFiles, waitForLock } from "../process/lockfile.js";
import { processExists } from "../process/process-utils.js";
import { warnSafely } from "./warn-safely.js";

const TEMP_INFIX = ".tmp.";
const PID_SUFFIX = /^\d+$/;

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
