import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { access, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { CREDENTIALS_DIR, CREDENTIALS_FILENAME } from "../constants.js";
import { CredentialStoreFileSchema, type Credential, type CredentialStoreFile } from "./types.js";
import { CredentialError } from "./errors.js";
import type { KeychainAdapter } from "./keychain.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAX_KEY_LENGTH = 256;

export interface CredentialStoreOptions {
  keychain: KeychainAdapter;
  filePath?: string;
}

// Note: CredentialStore is not concurrency-safe. Concurrent read-modify-write
// cycles (e.g. two `set()` calls in parallel) may lose writes. This is
// acceptable for CLI usage; callers requiring concurrency should serialize
// access externally.

export class CredentialStore {
  private readonly keychain: KeychainAdapter;
  private readonly filePath: string;

  constructor(options: CredentialStoreOptions) {
    this.keychain = options.keychain;
    this.filePath =
      options.filePath ??
      join(homedir(), CREDENTIALS_DIR, CREDENTIALS_FILENAME);
  }

  async get(key: string): Promise<Credential | undefined> {
    this._validateKey(key);
    if (!await this._storeFileExists()) return undefined;
    const masterKey = await this._getExistingMasterKey();
    const store = await this._readStore(masterKey);
    return Object.hasOwn(store.credentials, key)
      ? store.credentials[key]
      : undefined;
  }

  async set(key: string, credential: Credential): Promise<void> {
    this._validateKey(key);
    const masterKey = await this._getOrCreateMasterKey();
    const store = await this._readStore(masterKey);
    store.credentials[key] = credential;
    await this._writeStore(store, masterKey);
  }

  async delete(key: string): Promise<boolean> {
    this._validateKey(key);
    if (!await this._storeFileExists()) return false;
    const masterKey = await this._getExistingMasterKey();
    const store = await this._readStore(masterKey);
    if (!Object.hasOwn(store.credentials, key)) {
      return false;
    }
    delete store.credentials[key];
    await this._writeStore(store, masterKey);
    return true;
  }

  async list(): Promise<string[]> {
    if (!await this._storeFileExists()) return [];
    const masterKey = await this._getExistingMasterKey();
    const store = await this._readStore(masterKey);
    return Object.keys(store.credentials);
  }

  // --- Internal ---

  private _validateKey(key: string): void {
    if (!key) {
      throw new CredentialError("Credential key must not be empty");
    }
    if (key === "__proto__") {
      throw new CredentialError(
        `Credential key "${key}" is reserved and cannot be used`,
      );
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new CredentialError(
        `Credential key too long: ${key.length} characters (max ${MAX_KEY_LENGTH})`,
      );
    }
  }

  private async _storeFileExists(): Promise<boolean> {
    try {
      await access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async _getOrCreateMasterKey(): Promise<Buffer> {
    const existing = await this.keychain.getKey();
    if (existing) return existing;
    const key = randomBytes(32);
    await this.keychain.setKey(key);
    return key;
  }

  private async _getExistingMasterKey(): Promise<Buffer> {
    const existing = await this.keychain.getKey();
    if (!existing) {
      throw new CredentialError(
        "No master key found in keychain — cannot decrypt credential store. " +
        "If the keychain was reset, the credential store must be recreated.",
      );
    }
    return existing;
  }

  private _encrypt(data: Buffer, key: Buffer): Buffer {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, encrypted, authTag]);
  }

  private _decrypt(blob: Buffer, key: Buffer): Buffer {
    const minLength = IV_LENGTH + AUTH_TAG_LENGTH;
    if (blob.length < minLength) {
      throw new CredentialError(
        "Credential store file is corrupted: data too short",
      );
    }

    const iv = blob.subarray(0, IV_LENGTH);
    const authTag = blob.subarray(blob.length - AUTH_TAG_LENGTH);
    const ciphertext = blob.subarray(IV_LENGTH, blob.length - AUTH_TAG_LENGTH);

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
      throw new CredentialError(
        "Failed to decrypt credential store: wrong key or corrupted data",
        { cause: err },
      );
    }
  }

  private async _readStore(masterKey: Buffer): Promise<CredentialStoreFile> {
    let raw: Buffer;
    try {
      raw = await readFile(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, credentials: {} };
      }
      throw new CredentialError(
        `Failed to read credential store: ${(err as Error).message}`,
        { cause: err },
      );
    }

    const decrypted = this._decrypt(raw, masterKey);

    let json: unknown;
    try {
      json = JSON.parse(decrypted.toString("utf-8"));
    } catch (err) {
      throw new CredentialError(
        "Credential store contains invalid JSON",
        { cause: err },
      );
    }

    const result = CredentialStoreFileSchema.safeParse(json);
    if (!result.success) {
      throw new CredentialError(
        "Credential store has invalid schema",
        { cause: result.error },
      );
    }

    return result.data;
  }

  private async _writeStore(store: CredentialStoreFile, masterKey: Buffer): Promise<void> {
    const data = Buffer.from(JSON.stringify(store), "utf-8");
    const encrypted = this._encrypt(data, masterKey);

    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    const tmpPath = `${this.filePath}.tmp.${process.pid}`;
    await writeFile(tmpPath, encrypted, { mode: 0o600 });
    await rename(tmpPath, this.filePath);
  }
}
