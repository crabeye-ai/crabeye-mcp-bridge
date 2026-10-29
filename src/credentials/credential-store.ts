import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { access, open, readFile, unlink } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { CREDENTIALS_DIR, CREDENTIALS_FILENAME } from "../constants.js";
import type { Logger } from "../logging/index.js";
import { CredentialStoreFileSchema, type Credential, type CredentialStoreFile } from "./types.js";
import { CredentialError } from "./errors.js";
import type { KeychainAdapter } from "./keychain.js";
import { replaceStoreFile, storeTempPath, withStoreWriteLock } from "./store-write-lock.js";
import { warnSafely } from "./warn-safely.js";

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
   * The same budget covers waiting for another process to release the
   * store's lock file. On timeout the closure is told to give up: it stops
   * waiting for that lock, and a wedged one (e.g. a keychain call the user
   * is still ignoring) keeps running but doesn't write the store once it
   * completes.
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
 * Liveness: pass `opts.timeoutMs` to reject the caller and abort the
 * signal passed to `fn` after the budget expires. The chain is NOT
 * released on timeout — it stays held until the closure actually
 * settles — because the wedged closure may still hold the store lock,
 * still use this process's temp file, or still create the master key,
 * and would race the next waiter if we let one in early.
 */
class AsyncMutex {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(fn: (giveUp: AbortSignal) => Promise<T>, opts?: RunOptions): Promise<T> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => {
      release = r;
    });
    await prev;

    const giveUp = new AbortController();
    const work = (async () => {
      try {
        return await fn(giveUp.signal);
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
          `Credential store ${op} exceeded ${timeoutMs}ms waiting for a ` +
          `keychain call or another process's store lock; a keychain call ` +
          `still in progress keeps later writes queued until it settles.`;
        const error = new CredentialError(msg);
        giveUp.abort(error);
        warnSafely(opts?.logger, msg);
        reject(error);
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
// Across processes (bridges, CLI commands), each mutating op also holds the
// store's lock file (`withStoreWriteLock`) for its whole read-modify-write,
// including master-key creation, so a process that waited behind the key's
// creator reuses that key. The lock is taken over only from a holder that
// has died. The temp file is fsynced before the rename. Writers from 1.3.0
// or earlier don't take the lock and can still race.
//
// Path keying: `getMutex()` canonicalizes via `path.resolve` and lowercases
// on case-insensitive filesystems, but does NOT resolve symlinks. Stores
// reaching one file through different path strings get separate in-process
// queues and are serialized by the lock file alone.

class DecryptError extends CredentialError {}

export type ConditionalChange<Changed extends string> = Changed | "kept" | "missing";

const CASE_INSENSITIVE_FS =
  process.platform === "darwin" || process.platform === "win32";

export class CredentialStore {
  private static readonly mutexes = new Map<string, AsyncMutex>();

  private readonly keychain: KeychainAdapter;
  private readonly filePath: string;
  private readonly logger: Logger | undefined;
  private readonly lockTimeoutMs: number | undefined;
  private masterKey: Promise<Buffer | undefined> | undefined;

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
    const { store } = await this._openStore(await this._getExistingMasterKey());
    return Object.hasOwn(store.credentials, key)
      ? store.credentials[key]
      : undefined;
  }

  async set(key: string, credential: Credential): Promise<void> {
    this._validateKey(key);
    await this._mutate("set", async (giveUp) => {
      await this._forgetMasterKeyIfStoreMissing();
      const { store, masterKey } = await this._openStore(await this._getOrCreateMasterKey());
      store.credentials[key] = credential;
      await this._writeStore(store, masterKey, giveUp);
    });
  }

  async delete(key: string): Promise<boolean> {
    this._validateKey(key);
    return this._mutateExistingStore("delete", false, async (giveUp) => {
      const { store, masterKey } = await this._openStore(await this._getExistingMasterKey());
      if (!Object.hasOwn(store.credentials, key)) {
        return false;
      }
      delete store.credentials[key];
      await this._writeStore(store, masterKey, giveUp);
      return true;
    });
  }

  /**
   * Delete `key` only if `shouldDelete` approves what is stored, checking and
   * deleting in one read-modify-write under the store lock so no other write
   * can land in between.
   */
  async deleteIf(
    key: string,
    shouldDelete: (stored: Credential) => boolean,
  ): Promise<ConditionalChange<"deleted">> {
    return this._changeIfStored("deleteIf", key, shouldDelete, "deleted", (credentials) => {
      delete credentials[key];
    });
  }

  /**
   * Replace `key` with `credential` only if `shouldReplace` approves what is
   * stored, under the store lock. A missing entry is left missing.
   */
  async replaceIf(
    key: string,
    credential: Credential,
    shouldReplace: (stored: Credential) => boolean,
  ): Promise<ConditionalChange<"replaced">> {
    return this._changeIfStored("replaceIf", key, shouldReplace, "replaced", (credentials) => {
      credentials[key] = credential;
    });
  }

  /**
   * Delete multiple credentials in a single read-modify-write cycle so two
   * related entries (e.g. `oauth:<srv>` + `oauth-client-secret:<srv>`) can't
   * land out-of-sync if a concurrent writer interleaves between two `delete()`
   * calls. Returns the keys that were actually present and removed.
   */
  async deleteMany(keys: string[]): Promise<string[]> {
    for (const key of keys) this._validateKey(key);
    return this._mutateExistingStore("deleteMany", [], async (giveUp) => {
      const { store, masterKey } = await this._openStore(await this._getExistingMasterKey());
      const removed: string[] = [];
      for (const key of keys) {
        if (Object.hasOwn(store.credentials, key)) {
          delete store.credentials[key];
          removed.push(key);
        }
      }
      if (removed.length === 0) return [];
      await this._writeStore(store, masterKey, giveUp);
      return removed;
    });
  }

  async list(): Promise<string[]> {
    if (!await this._storeFileExists()) return [];
    const { store } = await this._openStore(await this._getExistingMasterKey());
    return Object.keys(store.credentials);
  }

  // --- Internal ---

  private _changeIfStored<Changed extends string>(
    label: string,
    key: string,
    shouldChange: (stored: Credential) => boolean,
    changed: Changed,
    change: (credentials: Record<string, Credential>) => void,
  ): Promise<ConditionalChange<Changed>> {
    this._validateKey(key);
    return this._mutateExistingStore<ConditionalChange<Changed>>(label, "missing", async (giveUp) => {
      const { store, masterKey } = await this._openStore(await this._getExistingMasterKey());
      if (!Object.hasOwn(store.credentials, key)) return "missing";
      if (!shouldChange(store.credentials[key])) return "kept";
      change(store.credentials);
      await this._writeStore(store, masterKey, giveUp);
      return changed;
    });
  }

  private _mutate<T>(label: string, body: (giveUp: AbortSignal) => Promise<T>): Promise<T> {
    return this.getMutex().run((giveUp) => this._underStoreLock(giveUp, body), this._runOptions(label));
  }

  private _mutateExistingStore<T>(
    label: string,
    whenStoreMissing: T,
    body: (giveUp: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.getMutex().run(
      async (giveUp) => (await this._storeFileExists() ? this._underStoreLock(giveUp, body) : whenStoreMissing),
      this._runOptions(label),
    );
  }

  private _underStoreLock<T>(giveUp: AbortSignal, body: (giveUp: AbortSignal) => Promise<T>): Promise<T> {
    return withStoreWriteLock(this.filePath, { giveUp, logger: this.logger }, () => body(giveUp));
  }

  private _runOptions(label: string): RunOptions {
    return { timeoutMs: this.lockTimeoutMs, logger: this.logger, label };
  }

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

  private async _storeFileMayExist(): Promise<boolean> {
    try {
      await access(this.filePath);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ENOENT";
    }
  }

  private _loadMasterKey(): Promise<Buffer | undefined> {
    if (this.masterKey) return this.masterKey;
    const pending = this.keychain.getKey();
    this.masterKey = pending;
    pending.then(
      (key) => { if (!key) this._forgetMasterKey(pending); },
      () => this._forgetMasterKey(pending),
    );
    return pending;
  }

  private _forgetMasterKey(pending: Promise<Buffer | undefined>): void {
    if (this.masterKey === pending) this.masterKey = undefined;
  }

  private async _forgetMasterKeyIfStoreMissing(): Promise<void> {
    if (!await this._storeFileExists()) this.masterKey = undefined;
  }

  private async _refetchMasterKey(stale: Buffer): Promise<Buffer | undefined> {
    const cached = this.masterKey;
    if (cached) {
      const current = await cached.catch(() => undefined);
      if (current && !current.equals(stale)) return current;
      this._forgetMasterKey(cached);
    }
    return this._loadMasterKey();
  }

  private async _getOrCreateMasterKey(): Promise<Buffer> {
    const existing = await this._loadMasterKey();
    if (existing) return existing;
    if (await this._storeFileMayExist()) this._noMasterKey();
    const key = randomBytes(32);
    await this.keychain.setKey(key);
    this.masterKey = Promise.resolve(key);
    return key;
  }

  private async _getExistingMasterKey(): Promise<Buffer> {
    return (await this._loadMasterKey()) ?? this._noMasterKey();
  }

  private _noMasterKey(): never {
    throw new CredentialError(
      "No master key found in keychain — cannot decrypt credential store. " +
      "If the keychain was reset, the credential store must be recreated.",
    );
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
      throw new DecryptError(
        "Failed to decrypt credential store: wrong key or corrupted data",
        { cause: err },
      );
    }
  }

  private async _openStore(masterKey: Buffer): Promise<{ store: CredentialStoreFile; masterKey: Buffer }> {
    const raw = await this._readStoreFile();
    if (!raw) return { store: { version: 1, credentials: {} }, masterKey };
    try {
      return { store: this._parseStore(this._decrypt(raw, masterKey)), masterKey };
    } catch (err) {
      if (!(err instanceof DecryptError)) throw err;
      const current = (await this._refetchMasterKey(masterKey)) ?? this._noMasterKey();
      if (current.equals(masterKey)) throw err;
      return { store: this._parseStore(this._decrypt(raw, current)), masterKey: current };
    }
  }

  private async _readStoreFile(): Promise<Buffer | undefined> {
    try {
      return await readFile(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new CredentialError(
        `Failed to read credential store: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  private _parseStore(decrypted: Buffer): CredentialStoreFile {
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

  private async _writeStore(store: CredentialStoreFile, masterKey: Buffer, giveUp: AbortSignal): Promise<void> {
    const data = Buffer.from(JSON.stringify(store), "utf-8");
    const encrypted = this._encrypt(data, masterKey);

    const tmpPath = storeTempPath(this.filePath);
    await unlink(tmpPath).catch(() => {});
    try {
      const tmp = await open(tmpPath, "wx", 0o600);
      try {
        await tmp.writeFile(encrypted);
        await tmp.sync();
      } finally {
        await tmp.close();
      }
      await replaceStoreFile(tmpPath, this.filePath, giveUp);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }
}
