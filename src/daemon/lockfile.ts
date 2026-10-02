import { link, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { parsePid, processExists } from "../process/process-utils.js";

export const LOCK_SETTLE_MS = 60_000;
const ABANDONED_STAGING_AGE_MS = 5_000;

const heldTokens = new Map<string, string>();
const handleTokens = new WeakMap<LockHandle, string>();

export async function holdsLock(path: string): Promise<boolean> {
  const token = heldTokens.get(path);
  if (token === undefined) return false;
  const body = await readBodySafe(path);
  return body !== null && tokenOf(body) === token;
}

export class LockHandle {
  private released = false;

  constructor(
    public readonly path: string,
    private readonly token: string,
  ) {
    handleTokens.set(this, token);
  }


  async isHeld(): Promise<boolean> {
    if (this.released) return false;
    const body = await readBodySafe(this.path);
    return body !== null && tokenOf(body) === this.token;
  }

  async release(): Promise<void> {
    const held = await this.isHeld();
    this.released = true;
    if (heldTokens.get(this.path) === this.token) heldTokens.delete(this.path);
    if (!held) return;
    const claimed = `${this.path}.${this.token}.release`;
    try {
      await rename(this.path, claimed);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    const now = new Date();
    await utimes(claimed, now, now).catch(() => {});
    const body = await readBodySafe(claimed);
    if (body === null || tokenOf(body) === this.token) {
      await unlink(claimed).catch(() => {});
      return;
    }
    await restoreLock(claimed, this.path, body);
  }
}

export interface AcquireOptions {
  pid?: number;
  stealStale?: boolean;
  isProcessAlive?: (pid: number) => boolean;
  isForeignProcess?: (pid: number) => Promise<boolean>;
  maxAgeMs?: number;
  track?: boolean;
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

export async function acquireLock(path: string, opts: AcquireOptions = {}): Promise<LockHandle> {
  const handle = await acquireUntrackedLock(path, opts);
  if (opts.track) heldTokens.set(path, handleTokens.get(handle)!);
  return handle;
}

async function acquireUntrackedLock(path: string, opts: AcquireOptions): Promise<LockHandle> {
  const pid = opts.pid ?? process.pid;
  const stealStale = opts.stealStale ?? true;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await createLock(path, pid);
    } catch (err) {
      if (!isEexist(err)) throw err;
    }
    const body = await readBodySafe(path);
    if (body === null) continue;
    if (!stealStale || !(await isStale(path, body, opts))) {
      throw new LockBusyError(path, parsePid(body));
    }
    return await stealLock(path, body, pid, opts);
  }
  throw new LockBusyError(path, await readLockHolderPid(path));
}

export async function sweepAbandonedLockFiles(lockPath: string): Promise<void> {
  const prefix = `${basename(lockPath)}.`;
  const dir = dirname(lockPath);
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const name of entries) {
    if (!name.startsWith(prefix) || !(name.endsWith(".tmp") || name.endsWith(".release"))) continue;
    const path = join(dir, name);
    if (await ageExceeds(path, ABANDONED_STAGING_AGE_MS)) await unlink(path).catch(() => {});
  }
}

async function createLock(path: string, pid: number): Promise<LockHandle> {
  const token = randomUUID();
  const body = `${pid}\n${token}\n`;
  const staging = `${path}.${token}.tmp`;
  await writeFile(staging, body, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  try {
    await link(staging, path);
  } catch (err) {
    if (!isHardLinkUnsupported(err)) throw err;
    await writeFile(path, body, { encoding: "utf-8", mode: 0o600, flag: "wx" });
  } finally {
    await unlink(staging).catch(() => {});
  }
  return new LockHandle(path, token);
}

async function restoreLock(claimed: string, path: string, body: string): Promise<void> {
  try {
    await link(claimed, path);
  } catch (err) {
    if (isHardLinkUnsupported(err)) {
      await writeFile(path, body, { encoding: "utf-8", mode: 0o600, flag: "wx" }).catch(() => {});
    }
  } finally {
    await unlink(claimed).catch(() => {});
  }
}

async function createLockOrBusy(path: string, pid: number, reportedPath = path): Promise<LockHandle> {
  try {
    return await createLock(path, pid);
  } catch (err) {
    if (isEexist(err)) throw new LockBusyError(reportedPath, await readLockHolderPid(reportedPath));
    throw err;
  }
}

export async function isLockLive(
  path: string,
  opts: Pick<AcquireOptions, "maxAgeMs" | "isProcessAlive"> = {},
): Promise<boolean> {
  const body = await readBodySafe(path);
  return body !== null && !(await isStale(path, body, opts));
}

export async function readLockHolderPid(path: string): Promise<number | null> {
  const body = await readBodySafe(path);
  return body === null ? null : parsePid(body);
}

async function isStale(path: string, body: string, opts: AcquireOptions): Promise<boolean> {
  if (opts.maxAgeMs !== undefined && (await ageExceeds(path, opts.maxAgeMs))) return true;
  const holder = parsePid(body);
  if (holder === null) return ageExceeds(path, LOCK_SETTLE_MS);
  const isAlive = opts.isProcessAlive ?? processExists;
  if (!isAlive(holder)) return true;
  return opts.isForeignProcess !== undefined && (await opts.isForeignProcess(holder));
}

async function stealLock(
  path: string,
  staleBody: string,
  pid: number,
  opts: AcquireOptions,
): Promise<LockHandle> {
  const guard = await acquireStealGuard(path, pid, opts);
  try {
    const current = await readBodySafe(path);
    if (current !== null && current !== staleBody) {
      throw new LockBusyError(path, parsePid(current));
    }
    await unlink(path).catch(ignoreEnoent);
    return await createLockOrBusy(path, pid);
  } finally {
    await guard.release();
  }
}

async function acquireStealGuard(
  path: string,
  pid: number,
  opts: AcquireOptions,
): Promise<LockHandle> {
  const guardPath = `${path}.steal`;
  try {
    return await createLock(guardPath, pid);
  } catch (err) {
    if (!isEexist(err)) throw err;
  }
  const guardBody = await readBodySafe(guardPath);
  if (guardBody === null) return createLockOrBusy(guardPath, pid, path);
  if (!(await isAbandonedGuard(guardPath, guardBody, opts))) {
    throw new LockBusyError(path, await readLockHolderPid(path));
  }
  if ((await readBodySafe(guardPath)) === guardBody) await unlink(guardPath).catch(ignoreEnoent);
  return createLockOrBusy(guardPath, pid, path);
}

async function isAbandonedGuard(
  guardPath: string,
  guardBody: string,
  opts: AcquireOptions,
): Promise<boolean> {
  const holder = parsePid(guardBody);
  const isAlive = opts.isProcessAlive ?? processExists;
  if (holder !== null && !isAlive(holder)) return true;
  return ageExceeds(guardPath, LOCK_SETTLE_MS);
}

async function ageExceeds(path: string, ageMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(path)).mtimeMs > ageMs;
  } catch {
    return false;
  }
}

async function readBodySafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function tokenOf(body: string): string | null {
  return body.split("\n")[1] ?? null;
}

function ignoreEnoent(err: unknown): void {
  if (!isEnoent(err)) throw err;
}

function isHardLinkUnsupported(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "ENOSYS" || code === "ENOTSUP";
}

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EEXIST";
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}
