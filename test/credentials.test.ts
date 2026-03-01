import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  BearerCredentialSchema,
  OAuth2CredentialSchema,
  CredentialSchema,
  CredentialStoreFileSchema,
  type Credential,
} from "../src/credentials/types.js";
import { CredentialError } from "../src/credentials/errors.js";
import { CredentialStore } from "../src/credentials/credential-store.js";
import {
  EnvKeychain,
  createKeychainAdapter,
  type KeychainAdapter,
} from "../src/credentials/keychain.js";

// --- Mock keychain ---

class MockKeychain implements KeychainAdapter {
  private key: Buffer | undefined;

  async getKey(): Promise<Buffer | undefined> {
    return this.key;
  }

  async setKey(key: Buffer): Promise<void> {
    this.key = key;
  }

  async deleteKey(): Promise<void> {
    this.key = undefined;
  }
}

// --- Test helpers ---

function tempDir(): string {
  return join(
    tmpdir(),
    `crabeye-cred-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

// --- Schema tests ---

describe("credential schemas", () => {
  it("validates a bearer credential", () => {
    const input = { type: "bearer", access_token: "ghp_abc123" };
    const result = BearerCredentialSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("bearer");
      expect(result.data.access_token).toBe("ghp_abc123");
    }
  });

  it("validates a full OAuth2 credential", () => {
    const input = {
      type: "oauth2",
      access_token: "ya29.abc",
      refresh_token: "1//0abc",
      token_endpoint: "https://oauth2.example.com/token",
      client_id: "client-123",
      expires_at: 1700000000,
    };
    const result = OAuth2CredentialSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("oauth2");
      expect(result.data.refresh_token).toBe("1//0abc");
      expect(result.data.expires_at).toBe(1700000000);
    }
  });

  it("validates a minimal OAuth2 credential", () => {
    const input = { type: "oauth2", access_token: "ya29.abc" };
    const result = OAuth2CredentialSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.refresh_token).toBeUndefined();
      expect(result.data.token_endpoint).toBeUndefined();
    }
  });

  it("rejects an invalid type", () => {
    const input = { type: "apikey", access_token: "abc" };
    const result = CredentialSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("rejects missing access_token", () => {
    const result = BearerCredentialSchema.safeParse({ type: "bearer" });
    expect(result.success).toBe(false);
  });

  it("rejects empty access_token", () => {
    const result = BearerCredentialSchema.safeParse({ type: "bearer", access_token: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty refresh_token", () => {
    const result = OAuth2CredentialSchema.safeParse({
      type: "oauth2",
      access_token: "tok",
      refresh_token: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-finite expires_at", () => {
    expect(OAuth2CredentialSchema.safeParse({
      type: "oauth2", access_token: "tok", expires_at: NaN,
    }).success).toBe(false);
    expect(OAuth2CredentialSchema.safeParse({
      type: "oauth2", access_token: "tok", expires_at: Infinity,
    }).success).toBe(false);
    expect(OAuth2CredentialSchema.safeParse({
      type: "oauth2", access_token: "tok", expires_at: -1,
    }).success).toBe(false);
    expect(OAuth2CredentialSchema.safeParse({
      type: "oauth2", access_token: "tok", expires_at: 1.5,
    }).success).toBe(false);
  });

  it("validates a credential store file", () => {
    const input = {
      version: 1,
      credentials: {
        github: { type: "bearer", access_token: "ghp_abc" },
        google: { type: "oauth2", access_token: "ya29.xyz" },
      },
    };
    const result = CredentialStoreFileSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.credentials)).toHaveLength(2);
    }
  });

  it("rejects an invalid version", () => {
    const input = { version: 2, credentials: {} };
    const result = CredentialStoreFileSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it("discriminated union picks correct schema", () => {
    const bearer = CredentialSchema.parse({
      type: "bearer",
      access_token: "tok",
    });
    expect(bearer.type).toBe("bearer");
    expect("refresh_token" in bearer).toBe(false);

    const oauth = CredentialSchema.parse({
      type: "oauth2",
      access_token: "tok",
      refresh_token: "ref",
    });
    expect(oauth.type).toBe("oauth2");
    if (oauth.type === "oauth2") {
      expect(oauth.refresh_token).toBe("ref");
    }
  });
});

// --- Encryption round-trip tests ---

describe("encryption round-trip", () => {
  let dir: string;
  let keychain: MockKeychain;

  beforeEach(async () => {
    dir = tempDir();
    await mkdir(dir, { recursive: true });
    keychain = new MockKeychain();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("encrypts and decrypts a credential", async () => {
    const filePath = join(dir, "creds.enc");
    const store = new CredentialStore({ keychain, filePath });

    const cred: Credential = { type: "bearer", access_token: "ghp_test123" };
    await store.set("github", cred);

    const retrieved = await store.get("github");
    expect(retrieved).toEqual(cred);
  });

  it("throws on wrong key", async () => {
    const filePath = join(dir, "creds.enc");

    // Write with one key
    const keychain1 = new MockKeychain();
    await keychain1.setKey(randomBytes(32));
    const store1 = new CredentialStore({ keychain: keychain1, filePath });
    await store1.set("key", { type: "bearer", access_token: "test" });

    // Read with different key
    const keychain2 = new MockKeychain();
    await keychain2.setKey(randomBytes(32));
    const store2 = new CredentialStore({ keychain: keychain2, filePath });

    await expect(store2.get("key")).rejects.toThrow(CredentialError);
    await expect(store2.get("key")).rejects.toThrow(/wrong key or corrupted/);
  });

  it("throws on truncated blob", async () => {
    const filePath = join(dir, "creds.enc");

    // Write valid data first
    const store = new CredentialStore({ keychain, filePath });
    await store.set("key", { type: "bearer", access_token: "test" });

    // Truncate the file
    const raw = await readFile(filePath);
    await writeFile(filePath, raw.subarray(0, 10));

    await expect(store.get("key")).rejects.toThrow(CredentialError);
    await expect(store.get("key")).rejects.toThrow(/too short/);
  });

  it("throws on corrupt data", async () => {
    const filePath = join(dir, "creds.enc");

    const store = new CredentialStore({ keychain, filePath });
    await store.set("key", { type: "bearer", access_token: "test" });

    // Corrupt the ciphertext
    const raw = await readFile(filePath);
    raw[15] ^= 0xff; // Flip a byte in the ciphertext
    await writeFile(filePath, raw);

    await expect(store.get("key")).rejects.toThrow(CredentialError);
  });

  it("produces different IV each time", async () => {
    const filePath1 = join(dir, "creds1.enc");
    const filePath2 = join(dir, "creds2.enc");

    // Use the same key for both
    const sharedKey = randomBytes(32);
    const kc1 = new MockKeychain();
    await kc1.setKey(sharedKey);
    const kc2 = new MockKeychain();
    await kc2.setKey(sharedKey);

    const store1 = new CredentialStore({ keychain: kc1, filePath: filePath1 });
    const store2 = new CredentialStore({ keychain: kc2, filePath: filePath2 });

    const cred: Credential = { type: "bearer", access_token: "same" };
    await store1.set("key", cred);
    await store2.set("key", cred);

    const raw1 = await readFile(filePath1);
    const raw2 = await readFile(filePath2);

    // First 12 bytes are the IV — they should differ
    const iv1 = raw1.subarray(0, 12);
    const iv2 = raw2.subarray(0, 12);
    expect(iv1.equals(iv2)).toBe(false);
  });
});

// --- CRUD tests ---

describe("CredentialStore CRUD", () => {
  let dir: string;
  let keychain: MockKeychain;
  let store: CredentialStore;

  beforeEach(async () => {
    dir = tempDir();
    await mkdir(dir, { recursive: true });
    keychain = new MockKeychain();
    store = new CredentialStore({
      keychain,
      filePath: join(dir, "creds.enc"),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("set + get returns credential", async () => {
    const cred: Credential = { type: "bearer", access_token: "tok123" };
    await store.set("mykey", cred);
    const result = await store.get("mykey");
    expect(result).toEqual(cred);
  });

  it("get missing key returns undefined", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeUndefined();
  });

  it("set overwrites existing credential", async () => {
    await store.set("key", { type: "bearer", access_token: "old" });
    await store.set("key", { type: "bearer", access_token: "new" });
    const result = await store.get("key");
    expect(result!.access_token).toBe("new");
  });

  it("delete returns true for existing key", async () => {
    await store.set("key", { type: "bearer", access_token: "tok" });
    const deleted = await store.delete("key");
    expect(deleted).toBe(true);
    const result = await store.get("key");
    expect(result).toBeUndefined();
  });

  it("delete returns false for missing key", async () => {
    const deleted = await store.delete("missing");
    expect(deleted).toBe(false);
  });

  it("list returns all keys", async () => {
    await store.set("a", { type: "bearer", access_token: "1" });
    await store.set("b", { type: "bearer", access_token: "2" });
    await store.set("c", { type: "bearer", access_token: "3" });
    const keys = await store.list();
    expect(keys).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(keys).toHaveLength(3);
  });

  it("list returns empty array when no credentials", async () => {
    const keys = await store.list();
    expect(keys).toEqual([]);
  });

  it("rejects empty credential key", async () => {
    await expect(
      store.set("", { type: "bearer", access_token: "tok" }),
    ).rejects.toThrow(/must not be empty/);
  });

  it("rejects overly long credential key", async () => {
    await expect(
      store.set("a".repeat(257), { type: "bearer", access_token: "tok" }),
    ).rejects.toThrow(/too long/);
  });

  it("rejects __proto__ as credential key", async () => {
    await expect(
      store.set("__proto__", { type: "bearer", access_token: "tok" }),
    ).rejects.toThrow(/reserved/);
  });

  it("get does not return Object.prototype properties", async () => {
    const result = await store.get("constructor");
    expect(result).toBeUndefined();
  });

  it("delete does not match Object.prototype properties", async () => {
    await store.set("real", { type: "bearer", access_token: "tok" });
    const deleted = await store.delete("constructor");
    expect(deleted).toBe(false);
  });

  it("throws when keychain is wiped but store file exists", async () => {
    await store.set("key", { type: "bearer", access_token: "tok" });

    // Simulate keychain wipe
    await keychain.deleteKey();

    // Read-only op should fail with clear message, not auto-generate a new key
    await expect(store.get("key")).rejects.toThrow(/No master key found/);

    // Keychain should still be empty (no auto-generation on read path)
    expect(await keychain.getKey()).toBeUndefined();
  });
});

// --- File I/O tests ---

describe("file I/O", () => {
  let dir: string;
  let keychain: MockKeychain;

  beforeEach(() => {
    dir = tempDir();
    keychain = new MockKeychain();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("auto-creates parent directory", async () => {
    const nested = join(dir, "sub", "dir");
    const filePath = join(nested, "creds.enc");
    const store = new CredentialStore({ keychain, filePath });

    await store.set("key", { type: "bearer", access_token: "tok" });

    const s = await stat(nested);
    expect(s.isDirectory()).toBe(true);
  });

  it("file has 0o600 permissions", async () => {
    const filePath = join(dir, "creds.enc");
    // Ensure dir exists for this test
    await mkdir(dir, { recursive: true });
    const store = new CredentialStore({ keychain, filePath });

    await store.set("key", { type: "bearer", access_token: "tok" });

    const s = await stat(filePath);
    // 0o600 = owner read+write only
    const mode = s.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("atomic write leaves no leftover .tmp files", async () => {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "creds.enc");
    const store = new CredentialStore({ keychain, filePath });

    await store.set("key", { type: "bearer", access_token: "tok" });

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    const tmpFiles = files.filter((f) => f.includes(".tmp."));
    expect(tmpFiles).toHaveLength(0);
  });

  it("throws on non-ENOENT read errors", async () => {
    // Create a directory where the file should be — readFile on a dir gives EISDIR
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "creds.enc");
    await mkdir(filePath); // filePath is now a directory

    // Keychain needs a key so _getExistingMasterKey doesn't throw first
    await keychain.setKey(randomBytes(32));
    const store = new CredentialStore({ keychain, filePath });
    await expect(store.get("key")).rejects.toThrow(CredentialError);
    await expect(store.get("key")).rejects.toThrow(/Failed to read credential store/);
  });
});

// --- Keychain factory tests ---

describe("createKeychainAdapter", () => {
  const originalEnv = process.env.MCP_BRIDGE_MASTER_KEY;
  const originalPlatform = process.platform;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MCP_BRIDGE_MASTER_KEY;
    } else {
      process.env.MCP_BRIDGE_MASTER_KEY = originalEnv;
    }
    // Restore platform
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("returns EnvKeychain when MCP_BRIDGE_MASTER_KEY is set", () => {
    process.env.MCP_BRIDGE_MASTER_KEY = "a".repeat(64);
    const adapter = createKeychainAdapter();
    expect(adapter).toBeInstanceOf(EnvKeychain);
  });

  it("returns MacKeychain on darwin", async () => {
    delete process.env.MCP_BRIDGE_MASTER_KEY;
    const { MacKeychain } = await import("../src/credentials/keychain.js");
    const adapter = createKeychainAdapter({ _platform: "darwin" });
    expect(adapter).toBeInstanceOf(MacKeychain);
  });

  it("returns LinuxKeychain on linux", async () => {
    delete process.env.MCP_BRIDGE_MASTER_KEY;
    const { LinuxKeychain } = await import("../src/credentials/keychain.js");
    const adapter = createKeychainAdapter({ _platform: "linux" });
    expect(adapter).toBeInstanceOf(LinuxKeychain);
  });

  it("returns WindowsKeychain on win32", async () => {
    delete process.env.MCP_BRIDGE_MASTER_KEY;
    const { WindowsKeychain } = await import("../src/credentials/keychain.js");
    const adapter = createKeychainAdapter({ _platform: "win32" });
    expect(adapter).toBeInstanceOf(WindowsKeychain);
  });

  it("uses _adapter override when provided", () => {
    const mock = new MockKeychain();
    const adapter = createKeychainAdapter({ _adapter: mock });
    expect(adapter).toBe(mock);
  });

  it("throws on unsupported platform", () => {
    delete process.env.MCP_BRIDGE_MASTER_KEY;
    expect(() => createKeychainAdapter({ _platform: "freebsd" as NodeJS.Platform })).toThrow(CredentialError);
    expect(() => createKeychainAdapter({ _platform: "freebsd" as NodeJS.Platform })).toThrow(/Unsupported platform/);
  });
});

// --- EnvKeychain tests ---

describe("EnvKeychain", () => {
  it("accepts valid 64-char hex key", async () => {
    const hex = randomBytes(32).toString("hex");
    const kc = new EnvKeychain(hex);
    const key = await kc.getKey();
    expect(key!.length).toBe(32);
    expect(key!.toString("hex")).toBe(hex);
  });

  it("throws on invalid hex characters", () => {
    expect(() => new EnvKeychain("g".repeat(64))).toThrow(CredentialError);
    expect(() => new EnvKeychain("g".repeat(64))).toThrow(/64 hex characters/);
  });

  it("throws on wrong length", () => {
    expect(() => new EnvKeychain("ab".repeat(16))).toThrow(CredentialError);
    expect(() => new EnvKeychain("ab".repeat(16))).toThrow(/64 hex characters/);
  });

  it("setKey throws", async () => {
    const kc = new EnvKeychain("a".repeat(64));
    await expect(kc.setKey(randomBytes(32))).rejects.toThrow(CredentialError);
    await expect(kc.setKey(randomBytes(32))).rejects.toThrow(/Cannot set/);
  });

  it("deleteKey throws", async () => {
    const kc = new EnvKeychain("a".repeat(64));
    await expect(kc.deleteKey()).rejects.toThrow(CredentialError);
    await expect(kc.deleteKey()).rejects.toThrow(/Cannot delete/);
  });
});

// --- Key auto-generation tests ---

describe("key auto-generation", () => {
  let dir: string;

  beforeEach(async () => {
    dir = tempDir();
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("first use generates and stores key", async () => {
    const keychain = new MockKeychain();
    const store = new CredentialStore({
      keychain,
      filePath: join(dir, "creds.enc"),
    });

    // Initially keychain has no key
    const initial = await keychain.getKey();
    expect(initial).toBeUndefined();

    // Setting a credential should auto-generate a key
    await store.set("key", { type: "bearer", access_token: "tok" });

    // Now keychain should have a key
    const key = await keychain.getKey();
    expect(key).toBeDefined();
    expect(key!.length).toBe(32);
  });

  it("second use retrieves existing key", async () => {
    const keychain = new MockKeychain();
    const filePath = join(dir, "creds.enc");

    const store1 = new CredentialStore({ keychain, filePath });
    await store1.set("key", { type: "bearer", access_token: "tok" });
    const key1 = await keychain.getKey();

    // Create new store instance with same keychain
    const store2 = new CredentialStore({ keychain, filePath });
    const result = await store2.get("key");
    expect(result!.access_token).toBe("tok");

    // Key should be the same
    const key2 = await keychain.getKey();
    expect(key1!.equals(key2!)).toBe(true);
  });

  it("propagates keychain errors that are not 'not found'", async () => {
    const failingKeychain: KeychainAdapter = {
      async getKey() { throw new CredentialError("keychain is locked: authentication required"); },
      async setKey() {},
      async deleteKey() {},
    };
    const filePath = join(dir, "creds.enc");
    const store = new CredentialStore({ keychain: failingKeychain, filePath });

    // Write a dummy file so _readStore doesn't short-circuit on ENOENT
    await writeFile(filePath, Buffer.from("dummy-data"));

    await expect(store.get("key")).rejects.toThrow(CredentialError);
    await expect(store.get("key")).rejects.toThrow(/keychain is locked/);
  });

  it("read-only ops do not generate a key when store does not exist", async () => {
    const keychain = new MockKeychain();
    const store = new CredentialStore({
      keychain,
      filePath: join(dir, "nonexistent.enc"),
    });

    // list and get should return empty results without touching keychain
    expect(await store.list()).toEqual([]);
    expect(await store.get("any")).toBeUndefined();
    expect(await store.delete("any")).toBe(false);

    // Keychain should still have no key
    expect(await keychain.getKey()).toBeUndefined();
  });

  it("propagates setKey failure during auto-generation", async () => {
    const failOnSetKeychain: KeychainAdapter = {
      async getKey() { return undefined; },
      async setKey() { throw new CredentialError("keychain write denied"); },
      async deleteKey() {},
    };
    const filePath = join(dir, "creds.enc");
    const store = new CredentialStore({ keychain: failOnSetKeychain, filePath });

    await expect(store.set("key", { type: "bearer", access_token: "tok" })).rejects.toThrow(/keychain write denied/);
  });
});

// --- CredentialError tests ---

describe("CredentialError", () => {
  it("has correct name and message", () => {
    const err = new CredentialError("test message");
    expect(err.name).toBe("CredentialError");
    expect(err.message).toBe("test message");
    expect(err).toBeInstanceOf(Error);
  });

  it("preserves cause", () => {
    const cause = new Error("original");
    const err = new CredentialError("wrapped", { cause });
    expect(err.cause).toBe(cause);
  });
});
