import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../../src/credentials/credential-store.js";
import { EnvKeychain } from "../../src/credentials/keychain.js";
import type { Credential } from "../../src/credentials/types.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { awaitHeld, exited, killAll, startLineProcess } from "../_helpers/processes.js";
import { MockKeychain, oauthTokens, secret } from "../_helpers/credential-store.js";

const MASTER_KEY = randomBytes(32).toString("hex");
const holdsRefreshToken = (refreshToken: string) => (stored: Credential) =>
  stored.type === "oauth2" && stored.refresh_token === refreshToken;

describe("conditional changes to a stored credential (#224)", { timeout: 30_000 }, () => {
  let lockScript: string;
  let dir: string;
  let storePath: string;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeAll(async () => {
    lockScript = await bundleForSubprocess("test/_helpers/subprocess/acquire-lock.ts", "acquire-lock");
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-conditional-change-"));
    storePath = join(dir, "credentials.enc");
  });

  afterEach(async () => {
    await killAll(children);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const store = (options: { lockTimeoutMs?: number } = {}) =>
    new CredentialStore({ keychain: new EnvKeychain(MASTER_KEY), filePath: storePath, ...options });
  const start = (script: string, args: string[]) => startLineProcess(children, script, args, { ...process.env, USERPROFILE: dir });
  const drainAbandonedWrites = () => store().delete("drain");

  it("reports a missing entry when there is no store yet, and creates neither a store nor a master key", async () => {
    const keychain = new MockKeychain();
    const fresh = new CredentialStore({ keychain, filePath: storePath });

    expect(await fresh.deleteIf("oauth:srv", () => true)).toBe("missing");
    expect(await fresh.replaceIf("oauth:srv", oauthTokens("rt-9"), () => true)).toBe("missing");

    expect(await keychain.getKey()).toBeUndefined();
    expect(existsSync(storePath)).toBe(false);
  });

  it("refuses an empty key, like every other store operation", async () => {
    await expect(store().deleteIf("", () => true)).rejects.toThrow("Credential key must not be empty");
    await expect(store().replaceIf("", secret("x"), () => true)).rejects.toThrow("Credential key must not be empty");
    await expect(store().setIf("", secret("x"), () => true)).rejects.toThrow("Credential key must not be empty");
  });

  describe("deleteIf", () => {
    it("deletes the entry when the check approves what is stored", async () => {
      await store().set("oauth:srv", oauthTokens("rt-1"));

      expect(await store().deleteIf("oauth:srv", holdsRefreshToken("rt-1"))).toBe("deleted");

      expect(await store().get("oauth:srv")).toBeUndefined();
    });

    it("keeps the entry, and every other one, when the check refuses", async () => {
      await store().set("oauth:srv", oauthTokens("rt-2"));
      await store().set("other", secret("x"));

      expect(await store().deleteIf("oauth:srv", holdsRefreshToken("rt-1"))).toBe("kept");

      expect(await store().get("oauth:srv")).toEqual(oauthTokens("rt-2"));
      expect(await store().get("other")).toEqual(secret("x"));
    });

    it("reports a missing entry without asking the check", async () => {
      await store().set("other", secret("x"));
      const check = vi.fn(() => true);

      expect(await store().deleteIf("oauth:srv", check)).toBe("missing");
      expect(check).not.toHaveBeenCalled();
    });

    it("checks what another store instance saved just before, never an older copy", async () => {
      const a = store();
      const b = store();
      await a.set("oauth:srv", oauthTokens("rt-1"));

      const saved = b.set("oauth:srv", oauthTokens("rt-2"));
      const outcome = a.deleteIf("oauth:srv", holdsRefreshToken("rt-1"));
      await saved;

      expect(await outcome).toBe("kept");
      expect(await store().get("oauth:srv")).toEqual(oauthTokens("rt-2"));
    });

    it("gives up, leaving the entry alone, when another process holds the lock past the timeout", async () => {
      await store().set("oauth:srv", oauthTokens("rt-1"));
      const holder = await awaitHeld(start(lockScript, [`${storePath}.lock`]));

      await expect(store({ lockTimeoutMs: 300 }).deleteIf("oauth:srv", () => true)).rejects.toThrow(/deleteIf exceeded 300ms/);
      holder.child.stdin.end();
      await exited(holder.child, 5_000);
      await drainAbandonedWrites();

      expect(await store().get("oauth:srv")).toEqual(oauthTokens("rt-1"));
    });
  });

  describe("replaceIf", () => {
    it("replaces the entry when the check approves what is stored", async () => {
      await store().set("oauth:srv", oauthTokens("rt-1"));

      expect(await store().replaceIf("oauth:srv", oauthTokens("rt-9"), holdsRefreshToken("rt-1"))).toBe("replaced");

      expect(await store().get("oauth:srv")).toEqual(oauthTokens("rt-9"));
    });

    it("keeps what is stored when the check refuses", async () => {
      await store().set("oauth:srv", oauthTokens("rt-2"));

      expect(await store().replaceIf("oauth:srv", oauthTokens("rt-9"), holdsRefreshToken("rt-1"))).toBe("kept");

      expect(await store().get("oauth:srv")).toEqual(oauthTokens("rt-2"));
    });

    it("doesn't create a missing entry", async () => {
      await store().set("other", secret("x"));

      expect(await store().replaceIf("oauth:srv", oauthTokens("rt-9"), () => true)).toBe("missing");

      expect(await store().get("oauth:srv")).toBeUndefined();
    });
  });

  describe("setIf", () => {
    it("replaces the entry when the check approves what is stored", async () => {
      await store().set("oauth:srv", oauthTokens("rt-1"));

      expect(await store().setIf("oauth:srv", oauthTokens("rt-9"), holdsRefreshToken("rt-1"))).toBe("replaced");

      expect(await store().get("oauth:srv")).toEqual(oauthTokens("rt-9"));
    });

    it("keeps what is stored when the check refuses", async () => {
      await store().set("oauth:srv", oauthTokens("rt-2"));

      expect(await store().setIf("oauth:srv", oauthTokens("rt-9"), holdsRefreshToken("rt-1"))).toBe("kept");

      expect(await store().get("oauth:srv")).toEqual(oauthTokens("rt-2"));
    });

    it("adds a missing entry without asking the check, keeping the others", async () => {
      await store().set("other", secret("x"));
      const check = vi.fn(() => false);

      expect(await store().setIf("oauth:srv", oauthTokens("rt-9"), check)).toBe("added");

      expect(check).not.toHaveBeenCalled();
      expect(await store().get("oauth:srv")).toEqual(oauthTokens("rt-9"));
      expect(await store().get("other")).toEqual(secret("x"));
    });

    it("creates the store when there is none yet", async () => {
      expect(await store().setIf("oauth:srv", oauthTokens("rt-9"), () => false)).toBe("added");

      expect(await store().get("oauth:srv")).toEqual(oauthTokens("rt-9"));
    });

    it("checks what another store instance saved just before, never an older copy", async () => {
      const first = store();
      await first.set("oauth:srv", oauthTokens("rt-1"));
      await store().set("oauth:srv", oauthTokens("rt-2"));

      expect(await first.setIf("oauth:srv", oauthTokens("rt-9"), holdsRefreshToken("rt-1"))).toBe("kept");

      expect(await first.get("oauth:srv")).toEqual(oauthTokens("rt-2"));
    });
  });
});
