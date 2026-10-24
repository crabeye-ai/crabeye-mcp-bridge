import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeychainAdapter } from "../../src/credentials/keychain.js";
import type { Logger } from "../../src/logging/index.js";
import { MockKeychain, secret, tempFiles, writeThroughAliasedPaths } from "../_helpers/credential-store.js";
import { deadPid, settledWithin } from "../_helpers/processes.js";

const lockControl = vi.hoisted(() => ({ failRelease: false, onSweep: () => {} }));

vi.mock("../../src/process/lockfile.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/process/lockfile.js")>();
  return {
    ...actual,
    sweepAbandonedLockFiles: async (...args: Parameters<typeof actual.sweepAbandonedLockFiles>) => {
      lockControl.onSweep();
      return actual.sweepAbandonedLockFiles(...args);
    },
    waitForLock: async (...args: Parameters<typeof actual.waitForLock>) => {
      const handle = await actual.waitForLock(...args);
      if (!lockControl.failRelease) return handle;
      const release = handle.release.bind(handle);
      handle.release = async () => {
        await release();
        throw new Error("EACCES: release refused");
      };
      return handle;
    },
  };
});

const { CredentialStore } = await import("../../src/credentials/credential-store.js");
const { withStoreWriteLock } = await import("../../src/credentials/store-write-lock.js");
const { acquireLock, readLockHolderPid } = await import("../../src/process/lockfile.js");

describe("credential store write lock", () => {
  let dir: string;
  let filePath: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-store-lock-"));
    filePath = join(dir, "creds.enc");
    lockPath = `${filePath}.lock`;
    lockControl.failRelease = false;
    lockControl.onSweep = () => {};
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the master key while holding the store lock", async () => {
    const seen: string[] = [];
    const keychain = new MockKeychain();
    const observing: KeychainAdapter = {
      getKey: async () => { seen.push(`get:${await readLockHolderPid(lockPath)}`); return keychain.getKey(); },
      setKey: async (key) => { seen.push(`set:${await readLockHolderPid(lockPath)}`); return keychain.setKey(key); },
      deleteKey: () => keychain.deleteKey(),
    };

    await new CredentialStore({ keychain: observing, filePath }).set("k", secret("1"));

    expect(seen).toEqual([`get:${process.pid}`, `set:${process.pid}`]);
  });

  it("reuses a key another process created while this one waited for the lock", async () => {
    const keychain = new MockKeychain();
    const setKey = vi.spyOn(keychain, "setKey");
    const holder = await acquireLock(lockPath);
    const otherKeychain = new MockKeychain();
    const otherDir = await mkdtemp(join(tmpdir(), "cbe-store-other-"));
    try {
      const waiting = new CredentialStore({ keychain, filePath }).set("second", secret("2"));
      await new CredentialStore({ keychain: otherKeychain, filePath: join(otherDir, "creds.enc") }).set("first", secret("1"));
      await keychain.setKey((await otherKeychain.getKey())!);
      await writeFile(filePath, await readFile(join(otherDir, "creds.enc")));
      await holder.release();
      await waiting;
    } finally {
      await holder.release();
      await rm(otherDir, { recursive: true, force: true });
    }

    expect(setKey).toHaveBeenCalledOnce();
    const store = new CredentialStore({ keychain: otherKeychain, filePath });
    expect((await store.list()).sort()).toEqual(["first", "second"]);
  });

  it("removes temp files left by dead writers and keeps live writers' ones", async () => {
    const dead = `${filePath}.tmp.${deadPid()}`;
    const live = `${filePath}.tmp.${process.ppid}`;
    const unrelated = join(dir, `other.enc.tmp.${deadPid()}`);
    const notAPid = `${filePath}.tmp.${deadPid()}.bak`;
    await writeFile(dead, "partial");
    await writeFile(live, "in flight");
    await writeFile(unrelated, "not ours");
    await writeFile(notAPid, "a backup");

    await new CredentialStore({ keychain: new MockKeychain(), filePath }).set("k", secret("1"));

    await expect(stat(dead)).rejects.toThrow();
    await expect(stat(live)).resolves.toBeDefined();
    await expect(stat(unrelated)).resolves.toBeDefined();
    await expect(stat(notAPid)).resolves.toBeDefined();
  });

  it("sweeps lock staging files a crashed writer left behind", async () => {
    const staging = `${lockPath}.dead-token.tmp`;
    await writeFile(staging, "1\ndead-token\n");
    const old = new Date(Date.now() - 60_000);
    await utimes(staging, old, old);

    await new CredentialStore({ keychain: new MockKeychain(), filePath }).set("k", secret("1"));

    await expect(stat(staging)).rejects.toThrow();
  });

  it("keeps a write that succeeded when releasing the lock fails, and warns", async () => {
    lockControl.failRelease = true;
    const warn = vi.fn();
    const store = new CredentialStore({ keychain: new MockKeychain(), filePath, logger: { warn } as unknown as Logger });

    await store.set("k", secret("1"));

    expect(await store.get("k")).toEqual(secret("1"));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Failed to release the credential store lock: EACCES/), expect.anything());
  });

  it("deletes against a missing store without creating its directory or a lock", async () => {
    const nested = join(dir, "never");
    const store = new CredentialStore({ keychain: new MockKeychain(), filePath: join(nested, "creds.enc") });

    expect(await store.delete("k")).toBe(false);
    expect(await store.deleteMany(["a", "b"])).toEqual([]);

    await expect(stat(nested)).rejects.toThrow();
  });

  it("refuses to replace the key when the store exists but the keychain returns none", async () => {
    const keychain = new MockKeychain();
    await new CredentialStore({ keychain, filePath }).set("before", secret("old"));
    const original = (await keychain.getKey())!;
    const emptied = new MockKeychain();
    const setKey = vi.spyOn(emptied, "setKey");

    await expect(new CredentialStore({ keychain: emptied, filePath }).set("k", secret("1"))).rejects.toThrow(/No master key found/);

    expect(setKey).not.toHaveBeenCalled();
    expect(await new CredentialStore({ keychain, filePath }).get("before")).toEqual(secret("old"));
    expect(original).toEqual(await keychain.getKey());
  });

  it.skipIf(process.platform === "win32")("creates the store's directory private to the user", async () => {
    const nested = join(dir, "fresh");

    await new CredentialStore({ keychain: new MockKeychain(), filePath: join(nested, "creds.enc") }).set("k", secret("1"));

    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  it("deletes only once the lock is free", async () => {
    const store = new CredentialStore({ keychain: new MockKeychain(), filePath });
    await store.set("one", secret("1"));
    await store.set("two", secret("2"));
    const holder = await acquireLock(lockPath);

    const deleting = Promise.all([store.delete("one"), store.deleteMany(["two"])]);
    expect(await settledWithin(deleting, 200)).toBe(false);
    await holder.release();

    expect(await deleting).toEqual([true, ["two"]]);
    expect(await store.list()).toEqual([]);
  });

  it("doesn't write once the caller has given up, even when a wedged keychain call completes", async () => {
    const key = randomBytes(32);
    const seeded = new MockKeychain();
    await seeded.setKey(key);
    await new CredentialStore({ keychain: seeded, filePath }).set("before", secret("old"));
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => (openGate = resolve));
    const wedged: KeychainAdapter = {
      getKey: async () => { await gate; return key; },
      setKey: async () => {},
      deleteKey: async () => {},
    };
    const store = new CredentialStore({ keychain: wedged, filePath, lockTimeoutMs: 100 });

    await expect(store.set("late", secret("new"))).rejects.toThrow(/exceeded 100ms/);
    openGate();
    await store.delete("nothing-to-delete");

    expect(await store.get("late")).toBeUndefined();
    expect(await store.get("before")).toEqual(secret("old"));
    expect(await tempFiles(dir)).toEqual([]);
  });

  it("never runs the write once the caller gives up waiting for the lock", async () => {
    const holder = await acquireLock(lockPath);
    let ran = false;

    await expect(withStoreWriteLock(filePath, { giveUp: AbortSignal.timeout(100) }, async () => { ran = true; })).rejects.toMatchObject({ name: "TimeoutError" });
    await holder.release();

    expect(ran).toBe(false);
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("never runs the write when the caller gives up just after the lock is taken", async () => {
    const giveUp = new AbortController();
    lockControl.onSweep = () => giveUp.abort(new Error("caller gave up"));
    let ran = false;

    await expect(withStoreWriteLock(filePath, { giveUp: giveUp.signal }, async () => { ran = true; })).rejects.toThrow("caller gave up");

    expect(ran).toBe(false);
    await expect(stat(lockPath)).rejects.toThrow();
  });

  it("serializes writers that share the file but not an in-process queue", async () => {
    const direct = await writeThroughAliasedPaths(dir, 30);

    expect(await direct.list()).toHaveLength(60);
    expect((await readdir(dir)).filter((name) => name.includes(".tmp.") || name.endsWith(".lock"))).toEqual([]);
  });
});
