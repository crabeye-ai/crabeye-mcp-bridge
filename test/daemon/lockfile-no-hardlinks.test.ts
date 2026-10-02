import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    },
  };
});

const { acquireLock, LockBusyError } = await import("../../src/daemon/lockfile.js");

describe("daemon lockfile on a filesystem without hard links", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-nolink-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("falls back to an exclusive create that still records pid and owner", async () => {
    const lockPath = join(dir, "m.lock");

    const handle = await acquireLock(lockPath, { pid: 4242 });

    expect((await readFile(lockPath, "utf-8")).split("\n")[0]).toBe("4242");
    expect(await handle.isHeld()).toBe(true);
    await expect(acquireLock(lockPath, { isProcessAlive: () => true })).rejects.toBeInstanceOf(
      LockBusyError,
    );
    await handle.release();
  });
});
