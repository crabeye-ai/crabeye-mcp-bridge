import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireLock, LockBusyError } from "../../src/daemon/lockfile.js";

function tempDir(): string {
  return join(
    tmpdir(),
    `crabeye-lock-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

describe("daemon lockfile", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = tempDir();
    lockPath = join(dir, "manager.lock");
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the lock and records pid", async () => {
    const handle = await acquireLock(lockPath, { pid: 12345 });
    const text = await readFile(lockPath, "utf-8");
    expect(text.trim()).toBe("12345");
    await handle.release();
  });

  it("releases unlink the file", async () => {
    const handle = await acquireLock(lockPath, { pid: 12345 });
    await handle.release();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("second acquire throws LockBusyError when holder is alive", async () => {
    const handle = await acquireLock(lockPath, {
      pid: process.pid,
      isProcessAlive: () => true,
    });
    await expect(
      acquireLock(lockPath, {
        pid: process.pid,
        isProcessAlive: () => true,
      }),
    ).rejects.toBeInstanceOf(LockBusyError);
    await handle.release();
  });

  it("LockBusyError reports the pid recorded in the lockfile", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(lockPath, "9999\n", { mode: 0o600 });

    try {
      await acquireLock(lockPath, {
        isProcessAlive: () => true,
        stealStale: false,
      });
      throw new Error("expected LockBusyError");
    } catch (err) {
      expect(err).toBeInstanceOf(LockBusyError);
      expect((err as LockBusyError).heldByPid).toBe(9999);
    }
  });

  it("steals a stale lock whose recorded pid is dead", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(lockPath, "9999\n", { mode: 0o600 });

    const handle = await acquireLock(lockPath, {
      pid: 4242,
      isProcessAlive: () => false,
    });
    expect((await readFile(lockPath, "utf-8")).trim()).toBe("4242");
    await handle.release();
  });

  it("two simultaneous acquirers — only one wins", async () => {
    const isAlive = (): boolean => true;
    const results = await Promise.allSettled([
      acquireLock(lockPath, { pid: 1, isProcessAlive: isAlive }),
      acquireLock(lockPath, { pid: 2, isProcessAlive: isAlive }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LockBusyError);
    const handle = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>>).value;
    await handle.release();
  });
});
