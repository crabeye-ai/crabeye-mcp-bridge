import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { access, readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { CREDENTIALS_DIR, CREDENTIALS_FILENAME } from "../constants.js";
import type { Logger } from "../logging/index.js";
import { CredentialStoreFileSchema, type Credential, type CredentialStoreFile } from "./types.js";
import { CredentialError } from "./errors.js";
import type { KeychainAdapter } from "./keychain.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const MAX_KEY_LENGTH = 256;
const DEFAULT_LOCK_TIMEOUT_MS = 60_000;

export interface CredentialStoreOptions {
  keychain: KeychainAdapter;
  filePath?: string;
  logger?: Logger;
  /**
   * Per-RMW timeout. When `set`/`delete`/`deleteMany` exceeds this, the
   * caller rejects with a `CredentialError` and `logger.warn` fires once;
   * the chain stays held until the wedged closure actually settles, so it
   * cannot race the next waiter on the file write.
   *
   * Caveat: this is a caller-facing "give up waiting" signal, NOT a
   * cancellation. The wedged closure (e.g. a keychain call the user is
   * still ignoring) keeps running, and if it eventually completes it WILL
   * write to disk — minutes or hours later than the caller expected. In a
   * single-process scenario the next queued write supersedes that late
   * write; the asymmetric case (cross-process writer between the timeout
   * and the late completion) is the same cross-process gap discussed in
   * the class-level comment.
   *
   * Default 60_000 ms. Pass `0` to disable.
   */
  lockTimeoutMs?: number;
}

interface RunOptions {
  timeoutMs?: number;
  logger?: Logger;
  /** Operation name used in the timeout error and the warning log. */
  label?: string;
}

/**
 * Tiny promise-chain mutex. `run(fn)` enqueues `fn` behind any earlier work
 * and resolves with its result; rejections in `fn` propagate to the caller
 * but do not poison the chain — the next `run()` proceeds normally.
 *
 * Liveness: pass `opts.timeoutMs` to reject the caller after the budget
 * expires. The chain is NOT released on timeout — it stays held until the
 * closure actually settles — because the wedged closure could still touch
 * the encrypted file via `_writeStore` and would race the next waiter if
 * we let one in early.
 */
class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>, opts?: RunOptions): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => {
      release = r;
    });
    await prev;

    const work = (async () => {
      try {
        return await fn();
      } finally {
        release();
      }
    })();

    const timeoutMs = opts?.timeoutMs;
    if (!timeoutMs) return work;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const op = opts?.label ?? "operation";
        const msg =
          `Credential store ${op} exceeded ${timeoutMs}ms; the underlying ` +
          `closure (likely a keychain call) is still running. Subsequent ` +
          `writes remain queued until it settles.`;
        // Defensive: a throwing user-supplied logger inside this callback
        // would unwind without scheduling `reject`, hanging the caller.
        try {
          opts?.logger?.warn(msg, { component: "credential_store" });
        } catch {
          // swallow
        }
        reject(new CredentialError(msg));
      }, timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

// Mutating ops (`set`, `delete`, `deleteMany`) are serialized in-process so
// concurrent read-modify-write cycles cannot lose writes. Reads (`get`,
// `list`) skip the lock — atomic rename on write means readers always see a
// self-consistent file (pre- or post-write, never a torn snapshot).
//
// Cross-process safety is *not* provided. The realistic race is a user
// running `mcp-bridge credential set` (or `auth <server>`) while the daemon
// is mid-refresh: both write through `_writeStore`, and `rename(2)` is atomic
// per call but not against another process's concurrent `rename(2)`. The
// loser's RMW silently overwrites the winner's data. Encryption is AEAD, so
// a half-written file fails GCM auth (loud failure, forces re-auth) rather
// than silently leaking — but a write *can* be lost. Revisit (e.g.
// `proper-lockfile`) if cross-process writers become routine.
//
// Path keying: `getMutex()` canonicalizes via `path.resolve` and lowercases
// on case-insensitive filesystems, but does NOT resolve symlinks. Callers
// constructing a store must pass the same canonical path string to share a
// lock — in this codebase that's enforced by computing the path once from
// constants in the constructor.

const CASE_INSENSITIVE_FS =
  process.platform === "darwin" || process.platform === "win32";

export class CredentialStore {
  private static readonly mutexes = new Map<string, AsyncMutex>();

  private readonly keychain: KeychainAdapter;
  private readonly filePath: string;
  private readonly logger: Logger | undefined;
  private readonly lockTimeoutMs: number | undefined;

  constructor(options: CredentialStoreOptions) {
    this.keychain = options.keychain;
    this.filePath =
      options.filePath ??
      join(homedir(), CREDENTIALS_DIR, CREDENTIALS_FILENAME);
    this.logger = options.logger;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  private getMutex(): AsyncMutex {
    // `resolve` collapses relatives and `..`; lowercase covers
    // case-insensitive FS where `Creds.enc` and `creds.enc` are the same
    // file. Symlinks are not followed (see class comment).
    let key = resolvePath(this.filePath);
    if (CASE_INSENSITIVE_FS) key = key.toLowerCase();
    let mutex = CredentialStore.mutexes.get(key);
    if (!mutex) {
      mutex = new AsyncMutex();
      CredentialStore.mutexes.set(key, mutex);
    }
    return mutex;
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
    await this.getMutex().run(async () => {
      const masterKey = await this._getOrCreateMasterKey();
      const store = await this._readStore(masterKey);
      store.credentials[key] = credential;
      await this._writeStore(store, masterKey);
    }, { timeoutMs: this.lockTimeoutMs, logger: this.logger, label: "set" });
  }

  async delete(key: string): Promise<boolean> {
    this._validateKey(key);
    return this.getMutex().run(async () => {
      if (!await this._storeFileExists()) return false;
      const masterKey = await this._getExistingMasterKey();
      const store = await this._readStore(masterKey);
      if (!Object.hasOwn(store.credentials, key)) {
        return false;
      }
      delete store.credentials[key];
      await this._writeStore(store, masterKey);
      return true;
    }, { timeoutMs: this.lockTimeoutMs, logger: this.logger, label: "delete" });
  }

  /**
   * Delete multiple credentials in a single read-modify-write cycle so two
   * related entries (e.g. `oauth:<srv>` + `oauth-client-secret:<srv>`) can't
   * land out-of-sync if a concurrent writer interleaves between two `delete()`
   * calls. Returns the keys that were actually present and removed.
   */
  async deleteMany(keys: string[]): Promise<string[]> {
    for (const key of keys) this._validateKey(key);
    return this.getMutex().run(async () => {
      if (!await this._storeFileExists()) return [];
      const masterKey = await this._getExistingMasterKey();
      const store = await this._readStore(masterKey);
      const removed: string[] = [];
      for (const key of keys) {
        if (Object.hasOwn(store.credentials, key)) {
          delete store.credentials[key];
          removed.push(key);
        }
      }
      if (removed.length === 0) return [];
      await this._writeStore(store, masterKey);
      return removed;
    }, { timeoutMs: this.lockTimeoutMs, logger: this.logger, label: "deleteMany" });
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
    // Defense-in-depth against prototype pollution. Reads already use
    // `Object.hasOwn` so the danger is theoretical, but writes through
    // bracket assignment would otherwise be observable as own-properties
    // shadowing prototype members.
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
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
    // 0o700 so co-located users can't even list the directory contents and
    // watch token-refresh mtimes. The file itself is already 0o600 below.
    await mkdir(dir, { recursive: true, mode: 0o700 });

    const tmpPath = `${this.filePath}.tmp.${process.pid}`;
    await writeFile(tmpPath, encrypted, { mode: 0o600 });
    await rename(tmpPath, this.filePath);
  }
}
