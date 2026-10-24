import { mkdtempSync, rmSync } from "node:fs";
import { readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CredentialStore } from "../../src/credentials/credential-store.js";
import type { KeychainAdapter } from "../../src/credentials/keychain.js";

/** In-memory keychain — same shape as the real adapters, no OS calls. */
export class MockKeychain implements KeychainAdapter {
  private key: Buffer | undefined;
  reads = 0;
  async getKey() { this.reads++; return this.key; }
  async setKey(k: Buffer) { this.key = k; }
  async deleteKey() { this.key = undefined; }
}

export const secret = (value: string) => ({ type: "secret" as const, value });

export async function tempFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.includes(".tmp."));
}

export async function writeThroughAliasedPaths(dir: string, count: number): Promise<CredentialStore> {
  const alias = join(dir, "alias");
  await symlink(dir, alias, "junction");
  const keychain = new MockKeychain();
  await keychain.setKey(randomBytes(32));
  const direct = new CredentialStore({ keychain, filePath: join(dir, "creds.enc") });
  const viaAlias = new CredentialStore({ keychain, filePath: join(alias, "creds.enc") });
  await Promise.all(
    Array.from({ length: count }, (_, i) => [
      direct.set(`direct-${i}`, secret(String(i))),
      viaAlias.set(`alias-${i}`, secret(String(i))),
    ]).flat(),
  );
  return direct;
}

export interface TestStoreHandle {
  store: CredentialStore;
  keychain: MockKeychain;
  filePath: string;
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
  const filePath = join(dir, "creds.enc");
  const store = new CredentialStore({ keychain, filePath });
  return {
    store,
    keychain,
    filePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
