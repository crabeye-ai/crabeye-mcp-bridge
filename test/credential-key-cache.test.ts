import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createCipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../src/credentials/credential-store.js";
import { CredentialError } from "../src/credentials/errors.js";
import type { KeychainAdapter } from "../src/credentials/keychain.js";
import { MockKeychain } from "./_helpers/credential-store.js";

const token = (value: string) => ({ type: "bearer" as const, access_token: value });

class ScriptedKeychain implements KeychainAdapter {
  reads = 0;
  constructor(private readonly replies: Array<() => Promise<Buffer | undefined>>) {}
  async getKey(): Promise<Buffer | undefined> {
    const reply = this.replies[Math.min(this.reads, this.replies.length - 1)]!;
    this.reads++;
    return reply();
  }
  async setKey(): Promise<void> {}
  async deleteKey(): Promise<void> {}
}

describe("master key cache", () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "crabeye-key-cache-"));
    filePath = join(dir, "creds.enc");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function seededStore(): Promise<{ store: CredentialStore; keychain: MockKeychain; key: Buffer }> {
    const keychain = new MockKeychain();
    const key = randomBytes(32);
    await keychain.setKey(key);
    const store = new CredentialStore({ keychain, filePath });
    await store.set("seed", token("s"));
    return { store, keychain, key };
  }

  async function rekeyFile(keychain: MockKeychain): Promise<CredentialStore> {
    rmSync(filePath);
    const next = new MockKeychain();
    const nextKey = randomBytes(32);
    await next.setKey(nextKey);
    const other = new CredentialStore({ keychain: next, filePath });
    await other.set("other", token("o"));
    await keychain.setKey(nextKey);
    return other;
  }

  it("reads the keychain once across reads and writes", async () => {
    const { store, keychain } = await seededStore();

    await store.get("seed");
    await store.set("a", token("1"));
    await store.list();
    await store.delete("a");
    await store.deleteMany(["seed"]);
    await store.get("seed");

    expect(keychain.reads).toBe(1);
  });

  it("shares one keychain read between concurrent first reads", async () => {
    const { key } = await seededStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const keychain = new ScriptedKeychain([async () => { await gate; return key; }]);
    const store = new CredentialStore({ keychain, filePath });

    const pending = Promise.all(Array.from({ length: 10 }, () => store.get("seed")));
    await vi.waitFor(() => expect(keychain.reads).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();

    expect(await pending).toEqual(Array.from({ length: 10 }, () => token("s")));
    expect(keychain.reads).toBe(1);
  });

  it("keeps a key it created on first write", async () => {
    const keychain = new MockKeychain();
    const store = new CredentialStore({ keychain, filePath });

    await store.set("a", token("1"));
    const readsAfterCreate = keychain.reads;
    await store.get("a");
    await store.set("b", token("2"));

    expect(keychain.reads).toBe(readsAfterCreate);
  });

  it("asks the keychain again after a failed read", async () => {
    const { key } = await seededStore();
    const keychain = new ScriptedKeychain([
      () => Promise.reject(new CredentialError("keychain is locked")),
      async () => key,
    ]);
    const store = new CredentialStore({ keychain, filePath });

    await expect(store.get("seed")).rejects.toThrow(/keychain is locked/);
    expect(await store.get("seed")).toEqual(token("s"));
    expect(keychain.reads).toBe(2);
  });

  it("asks the keychain again after an empty read", async () => {
    const { key } = await seededStore();
    const keychain = new ScriptedKeychain([async () => undefined, async () => key]);
    const store = new CredentialStore({ keychain, filePath });

    await expect(store.get("seed")).rejects.toThrow(/No master key found/);
    expect(await store.get("seed")).toEqual(token("s"));
    expect(keychain.reads).toBe(2);
  });

  it("picks up a key changed by another process with one more keychain read", async () => {
    const { store, keychain } = await seededStore();
    const other = await rekeyFile(keychain);

    expect(await store.get("other")).toEqual(token("o"));
    await store.set("mine", token("m"));

    expect(await other.get("mine")).toEqual(token("m"));
    expect(keychain.reads).toBe(2);
  });

  it.each([
    ["set", (store: CredentialStore) => store.set("mine", token("m")), ["mine", "other"]],
    ["delete", (store: CredentialStore) => store.delete("other"), []],
    ["deleteMany", (store: CredentialStore) => store.deleteMany(["other", "x"]), []],
  ] as const)("writes with the changed key when %s is the first call to find it", async (_label, write, remaining) => {
    const { store, keychain } = await seededStore();
    const other = await rekeyFile(keychain);

    await write(store);

    expect((await other.list()).sort()).toEqual(remaining);
    expect(keychain.reads).toBe(2);
  });

  it("writes a recreated store with the key the keychain holds now", async () => {
    const { store, keychain } = await seededStore();
    await keychain.deleteKey();
    rmSync(filePath);

    await store.set("fresh", token("f"));

    const restarted = new CredentialStore({ keychain, filePath });
    expect(await restarted.get("fresh")).toEqual(token("f"));
  });

  it("shares one re-read between concurrent calls that find the key changed", async () => {
    const { store, keychain } = await seededStore();
    await rekeyFile(keychain);

    const results = await Promise.all(Array.from({ length: 5 }, () => store.get("other")));

    expect(results).toEqual(Array.from({ length: 5 }, () => token("o")));
    expect(keychain.reads).toBe(2);
  });

  it("fails as before when the keychain still holds a key that does not decrypt the store", async () => {
    const { store, keychain } = await seededStore();
    writeFileSync(filePath, randomBytes(64));

    await expect(store.get("seed")).rejects.toThrow(/wrong key or corrupted data/);
    expect(keychain.reads).toBe(2);
  });

  it("fails as before when the keychain was emptied and the cached key no longer decrypts", async () => {
    const { store, keychain } = await seededStore();
    await rekeyFile(keychain);
    await keychain.deleteKey();

    await expect(store.get("other")).rejects.toThrow(/No master key found/);
    expect(keychain.reads).toBe(2);
  });

  it("keeps working on a cached key after the keychain is emptied", async () => {
    const { store, keychain } = await seededStore();
    await keychain.deleteKey();

    expect(await store.get("seed")).toEqual(token("s"));
  });

  it("does not re-read the keychain when the store decrypts but is not valid", async () => {
    const { store, keychain, key } = await seededStore();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update("not json"), cipher.final()]);
    writeFileSync(filePath, Buffer.concat([iv, body, cipher.getAuthTag()]));

    await expect(store.get("seed")).rejects.toThrow(/invalid JSON/);
    expect(keychain.reads).toBe(1);
  });
});
