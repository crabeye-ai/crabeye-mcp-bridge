import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CredentialStore } from "../../src/credentials/credential-store.js";
import type { KeychainAdapter } from "../../src/credentials/keychain.js";

/** In-memory keychain — same shape as the real adapters, no OS calls. */
export class MockKeychain implements KeychainAdapter {
  private key: Buffer | undefined;
  async getKey() { return this.key; }
  async setKey(k: Buffer) { this.key = k; }
  async deleteKey() { this.key = undefined; }
}

export interface TestStoreHandle {
  store: CredentialStore;
  /** Removes the tmpdir. Safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Spin up a `CredentialStore` backed by a fresh tmpdir + a pre-seeded
 * `MockKeychain`. Use in `beforeEach`; call `cleanup()` in `afterEach`.
 *
 * Pre-seeding the master key (instead of letting the store auto-generate
 * it) keeps the first `store.set` call cheap and means tests that exercise
 * read-only paths don't accidentally trigger key creation.
 */
export function makeTestStore(prefix = "crabeye-test-"): TestStoreHandle {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const keychain = new MockKeychain();
  void keychain.setKey(randomBytes(32));
  const store = new CredentialStore({
    keychain,
    filePath: join(dir, "creds.enc"),
  });
  return {
    store,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
