import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { MacKeychain } from "../../src/credentials/keychain.js";

const run = promisify(execFile);
const SECURITY = "/usr/bin/security";
const SERVICE = `crabeye-mcp-bridge-test-${randomBytes(4).toString("hex")}`;
const ACCOUNT = "master-key";

describe.runIf(process.platform === "darwin" && process.env.CI === "true")("MacKeychain on a scratch keychain", () => {
  let dir: string;
  let keychain: string;
  let searchList: string;

  beforeAll(async () => {
    searchList = (await run(SECURITY, ["list-keychains", "-d", "user"])).stdout;
    dir = mkdtempSync(join(tmpdir(), "cbe-keychain-"));
    keychain = join(dir, "scratch.keychain-db");
    await run(SECURITY, ["create-keychain", "-p", "scratch", keychain]);
    await run(SECURITY, ["unlock-keychain", "-p", "scratch", keychain]);
    await run(SECURITY, ["set-keychain-settings", keychain]);
    expect(existsSync(keychain)).toBe(true);
  });

  afterAll(async () => {
    if (keychain?.startsWith(`${dir}/`)) await run(SECURITY, ["delete-keychain", keychain]).catch(() => {});
    if (dir) rmSync(dir, { recursive: true, force: true });
    expect((await run(SECURITY, ["list-keychains", "-d", "user"])).stdout).toBe(searchList);
  });

  function scratchKeychain(): MacKeychain {
    return new MacKeychain({ _keychain: keychain, _service: SERVICE });
  }

  it("stores a key that both it and 1.3.0's lookup read back", async () => {
    const key = randomBytes(32);

    await scratchKeychain().setKey(key);

    expect(await scratchKeychain().getKey()).toEqual(key);
    const { stdout } = await run(SECURITY, ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", keychain]);
    expect(stdout.trim()).toBe(key.toString("hex"));
  });

  it("reads a key stored the way 1.3.0 stored it", async () => {
    const key = randomBytes(32);
    await run(SECURITY, ["add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", key.toString("hex"), "-U", keychain]);

    expect(await scratchKeychain().getKey()).toEqual(key);
  });

  it("replaces a stored key", async () => {
    const first = randomBytes(32);
    const second = randomBytes(32);

    await scratchKeychain().setKey(first);
    await scratchKeychain().setKey(second);

    expect(await scratchKeychain().getKey()).toEqual(second);
  });
});
