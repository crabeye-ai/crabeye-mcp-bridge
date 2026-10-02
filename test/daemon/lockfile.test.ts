import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readdir, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireLock,
  holdsLock,
  LockBusyError,
  LOCK_SETTLE_MS,
  sweepAbandonedLockFiles,
} from "../../src/daemon/lockfile.js";

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
    expect(text.split("\n")[0]).toBe("12345");
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
    expect((await readFile(lockPath, "utf-8")).split("\n")[0]).toBe("4242");
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

  async function backdate(path: string, ageMs: number): Promise<void> {
    const past = new Date(Date.now() - ageMs);
    await utimes(path, past, past);
  }

  const alive = (): boolean => true;

  it("treats a lockfile without a pid yet as busy", async () => {
    await writeFile(lockPath, "");

    await expect(acquireLock(lockPath)).rejects.toBeInstanceOf(LockBusyError);
  });

  it("steals a pid-less lockfile once it is older than the settle window", async () => {
    await writeFile(lockPath, "");
    await backdate(lockPath, LOCK_SETTLE_MS + 1_000);

    const handle = await acquireLock(lockPath, { pid: 4242 });

    expect((await readFile(lockPath, "utf-8")).split("\n")[0]).toBe("4242");
    await handle.release();
  });

  it("steals a lock whose live pid now belongs to an unrelated process", async () => {
    await writeFile(lockPath, "9999\n");

    const handle = await acquireLock(lockPath, {
      pid: 4242,
      isProcessAlive: alive,
      isForeignProcess: async () => true,
    });

    expect((await readFile(lockPath, "utf-8")).split("\n")[0]).toBe("4242");
    await handle.release();
  });

  it("never steals from a live daemon, however old its lock", async () => {
    await writeFile(lockPath, "9999\n");
    await backdate(lockPath, LOCK_SETTLE_MS + 1_000);

    await expect(
      acquireLock(lockPath, { isProcessAlive: alive, isForeignProcess: async () => false }),
    ).rejects.toBeInstanceOf(LockBusyError);
    await expect(acquireLock(lockPath, { isProcessAlive: alive })).rejects.toBeInstanceOf(
      LockBusyError,
    );
  });

  it("does not steal a lock that was replaced after it was judged stale", async () => {
    await writeFile(lockPath, "9999\n");
    const fresh = "7777\nsomeone-else\n";

    await expect(
      acquireLock(lockPath, {
        isProcessAlive: () => {
          writeFileSync(lockPath, fresh);
          return false;
        },
      }),
    ).rejects.toBeInstanceOf(LockBusyError);
    expect(await readFile(lockPath, "utf-8")).toBe(fresh);
  });

  it("backs off while another process is stealing, and recovers a steal its holder abandoned", async () => {
    await writeFile(lockPath, "9999\n");
    const guard = `${lockPath}.steal`;
    await writeFile(guard, "5555\nstealer\n");
    let stealerAlive = true;
    const isProcessAlive = (pid: number): boolean => pid === 5555 && stealerAlive;

    await expect(acquireLock(lockPath, { isProcessAlive })).rejects.toBeInstanceOf(LockBusyError);

    stealerAlive = false;
    const handle = await acquireLock(lockPath, { pid: 4242, isProcessAlive });
    expect((await readFile(lockPath, "utf-8")).split("\n")[0]).toBe("4242");
    await expect(stat(guard)).rejects.toThrow();
    await handle.release();
  });

  it("release leaves a successor's lock in place", async () => {
    const first = await acquireLock(lockPath, { pid: 1 });
    await unlink(lockPath);
    const second = await acquireLock(lockPath, { pid: 2 });

    await first.release();

    expect(await second.isHeld()).toBe(true);
    await second.release();
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("treats a lock older than maxAgeMs as stale even while its holder is alive", async () => {
    await writeFile(lockPath, "4242\nold-token\n");
    await backdate(lockPath, 120_000);

    const handle = await acquireLock(lockPath, { pid: 1, isProcessAlive: () => true, maxAgeMs: 60_000 });

    expect(await handle.isHeld()).toBe(true);
    await handle.release();
  });

  it("keeps a young lock with a live holder even when maxAgeMs is set", async () => {
    await writeFile(lockPath, "4242\nfresh-token\n");

    await expect(
      acquireLock(lockPath, { pid: 1, isProcessAlive: () => true, maxAgeMs: 60_000 }),
    ).rejects.toBeInstanceOf(LockBusyError);
  });

  it("knows which tracked locks this process still holds", async () => {
    const untracked = await acquireLock(`${lockPath}.untracked`, { pid: 1 });
    const tracked = await acquireLock(lockPath, { pid: 1, track: true });

    expect(await holdsLock(lockPath)).toBe(true);
    expect(await holdsLock(`${lockPath}.untracked`)).toBe(false);
    expect(await holdsLock(join(dir, "never-acquired.lock"))).toBe(false);

    await writeFile(lockPath, "2\nsomeone-else\n");
    expect(await holdsLock(lockPath)).toBe(false);

    await tracked.release();
    await untracked.release();
    expect(await holdsLock(lockPath)).toBe(false);
  });

  it("stops reporting a tracked lock as held once released", async () => {
    const tracked = await acquireLock(lockPath, { pid: 1, track: true });

    await tracked.release();

    expect(await holdsLock(lockPath)).toBe(false);
  });

  it("a second release is harmless and leaves no copies behind", async () => {
    const handle = await acquireLock(lockPath, { pid: 1 });

    await handle.release();
    await handle.release();

    await expect(stat(lockPath)).rejects.toThrow();
    expect((await readdir(dir)).filter((name) => name.startsWith("manager.lock"))).toEqual([]);
  });

  it("sweeps a release copy left by a crash mid-release", async () => {
    const abandoned = `${lockPath}.dead-token.release`;
    await writeFile(abandoned, "1\ndead-token\n");
    await backdate(abandoned, 60_000);

    await sweepAbandonedLockFiles(lockPath);

    await expect(stat(abandoned)).rejects.toThrow();
  });

  it("sweeps lock staging files left by a crash, but not ones still being written", async () => {
    const abandoned = `${lockPath}.dead-token.tmp`;
    const inFlight = `${lockPath}.live-token.tmp`;
    await writeFile(abandoned, "1\ndead-token\n");
    await writeFile(inFlight, "2\nlive-token\n");
    await backdate(abandoned, 60_000);

    await sweepAbandonedLockFiles(lockPath);

    await expect(stat(abandoned)).rejects.toThrow();
    await expect(stat(inFlight)).resolves.toBeDefined();
  });
});
