import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDir, ensurePrivateDirSync } from "../../src/process/private-dir.js";

const isWindows = process.platform === "win32";

describe.each([
  ["ensurePrivateDir", (dir: string, description: string) => ensurePrivateDir(dir, description)],
  ["ensurePrivateDirSync", async (dir: string, description: string) => ensurePrivateDirSync(dir, description)],
])("%s", (_name, ensure) => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbe-private-dir-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("creates the directory and its parents", async () => {
    const dir = join(root, "a", "b");
    await ensure(dir, "test dir");
    expect(existsSync(dir)).toBe(true);
  });

  it.skipIf(isWindows)("makes an existing directory private to the user", async () => {
    const dir = join(root, "open");
    mkdirSync(dir);
    chmodSync(dir, 0o755);

    await ensure(dir, "test dir");

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.skipIf(isWindows)("refuses a symlinked directory, naming it", async () => {
    const target = join(root, "target");
    mkdirSync(target);
    const link = join(root, "link");
    symlinkSync(target, link);

    await expect(ensure(link, "test dir")).rejects.toThrow(`refusing to use symlinked test dir: ${link}`);
  });
});
