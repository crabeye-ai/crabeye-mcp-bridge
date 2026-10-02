import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const vanishOnFirstRead: { path: string | null } = { path: null };

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (path: string, ...rest: unknown[]) => {
      if (path === vanishOnFirstRead.path) {
        vanishOnFirstRead.path = null;
        unlinkSync(path);
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      }
      return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest);
    }) as typeof actual.readFile,
  };
});

const { acquireLock } = await import("../../src/daemon/lockfile.js");

describe("daemon lockfile when the holder releases mid-acquire", () => {
  const dir = mkdtempSync(join(tmpdir(), "cbe-vanish-"));

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("retries and takes the lock instead of reporting it busy", async () => {
    const lockPath = join(dir, "m.lock");
    writeFileSync(lockPath, `${process.pid}\nprevious\n`);
    vanishOnFirstRead.path = lockPath;

    const handle = await acquireLock(lockPath, { pid: 4242 });

    expect(await handle.isHeld()).toBe(true);
    await handle.release();
  });
});
