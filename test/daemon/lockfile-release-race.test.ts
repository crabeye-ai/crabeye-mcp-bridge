import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const takeover = vi.hoisted(() => ({
  body: null as string | null,
  linkError: null as string | null,
  recreatedBody: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (takeover.body !== null && from.endsWith("manager.lock")) {
        await actual.writeFile(from, takeover.body);
        takeover.body = null;
      }
      await actual.rename(from, to);
      if (takeover.recreatedBody !== null && from.endsWith("manager.lock")) {
        await actual.writeFile(from, takeover.recreatedBody);
      }
    },
    link: async (from: string, to: string) => {
      if (takeover.linkError !== null && from.endsWith(".release")) {
        throw Object.assign(new Error(takeover.linkError), { code: takeover.linkError });
      }
      return actual.link(from, to);
    },
  };
});

const { acquireLock } = await import("../../src/daemon/lockfile.js");

describe("daemon lockfile release racing a takeover", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `crabeye-lock-race-${process.pid}-${Math.random().toString(36).slice(2)}`);
    lockPath = join(dir, "manager.lock");
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    takeover.body = null;
    takeover.linkError = null;
    takeover.recreatedBody = null;
    await rm(dir, { recursive: true, force: true });
  });

  it("restores a lock another process took over after the token check", async () => {
    const handle = await acquireLock(lockPath, { pid: 1 });
    takeover.body = "2\nsuccessor-token\n";

    await handle.release();

    expect(await readFile(lockPath, "utf-8")).toBe("2\nsuccessor-token\n");
    expect((await readdir(dir)).filter((name) => name !== "manager.lock")).toEqual([]);
  });

  it("removes its own lock when nothing raced it", async () => {
    const handle = await acquireLock(lockPath, { pid: 1 });

    await handle.release();

    expect(await readdir(dir)).toEqual([]);
  });

  it("leaves untouched a lock another process took before release", async () => {
    const handle = await acquireLock(lockPath, { pid: 1 });
    await writeFile(lockPath, "3\nsomeone-else\n");

    await handle.release();

    expect(await readFile(lockPath, "utf-8")).toBe("3\nsomeone-else\n");
  });

  it("restores a taken-over lock by rewriting it where hard links are unsupported", async () => {
    const handle = await acquireLock(lockPath, { pid: 1 });
    takeover.body = "2\nsuccessor-token\n";
    takeover.linkError = "EPERM";

    await handle.release();

    expect(await readFile(lockPath, "utf-8")).toBe("2\nsuccessor-token\n");
    expect((await readdir(dir)).filter((name) => name !== "manager.lock")).toEqual([]);
  });

  it("keeps a lock a third process created while the taken-over copy was set aside", async () => {
    const handle = await acquireLock(lockPath, { pid: 1 });
    takeover.body = "2\nsuccessor-token\n";
    takeover.recreatedBody = "3\nnewest-token\n";

    await handle.release();

    expect(await readFile(lockPath, "utf-8")).toBe("3\nnewest-token\n");
    expect((await readdir(dir)).filter((name) => name !== "manager.lock")).toEqual([]);
  });
});
