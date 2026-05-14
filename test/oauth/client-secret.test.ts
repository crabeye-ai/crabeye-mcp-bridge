import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveClientSecret,
  clientSecretKey,
  oauthCredentialKey,
  hasStoredOAuthCredential,
} from "../../src/oauth/client-secret.js";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import { makeTestStore } from "../_helpers/credential-store.js";

describe("resolveClientSecret", () => {
  let store: CredentialStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("client-secret-"));
  });

  afterEach(() => {
    cleanup();
  });

  it("priority 1: credential store wins over env and inline", async () => {
    await store.set(clientSecretKey("notion"), {
      type: "secret",
      value: "from-store",
    });
    const secret = await resolveClientSecret(
      "notion",
      "${NOTION_OAUTH_SECRET}",
      store,
      { NOTION_OAUTH_SECRET: "from-env" },
    );
    expect(secret).toBe("from-store");
  });

  it("priority 2: env-var reference resolves from env", async () => {
    const secret = await resolveClientSecret(
      "notion",
      "${NOTION_OAUTH_SECRET}",
      store,
      { NOTION_OAUTH_SECRET: "from-env" },
    );
    expect(secret).toBe("from-env");
  });

  it("priority 3: plain string passes through", async () => {
    const secret = await resolveClientSecret(
      "notion",
      "literal-secret",
      store,
      {},
    );
    expect(secret).toBe("literal-secret");
  });

  it("returns undefined when nothing is configured", async () => {
    const secret = await resolveClientSecret("notion", undefined, store, {});
    expect(secret).toBeUndefined();
  });

  it("throws when env ref points to an unset variable", async () => {
    await expect(
      resolveClientSecret("notion", "${MISSING_OAUTH}", store, {}),
    ).rejects.toThrow(/MISSING_OAUTH.*not set/);
  });

  it("rejects env-var names that don't contain OAUTH (anti-exfiltration)", async () => {
    for (const name of ["AWS_SECRET_ACCESS_KEY", "PATH", "HOME", "GH_TOKEN"]) {
      await expect(
        resolveClientSecret("srv", `\${${name}}`, store, { [name]: "leak" }),
      ).rejects.toThrow(/not allowed.*must contain "OAUTH"/);
    }
  });

  it("rejects names where OAUTH is a prefix without right boundary", async () => {
    // Tightened boundary: `OAUTH` must end at `_` or end-of-string. Names
    // that happen to start with `OAUTH` but continue into a word are
    // rejected so a tampered config can't exfiltrate something like
    // `OAUTHORITY` or `OAUTHIBITED`.
    for (const name of ["OAUTHORITY", "OAUTHIBITED", "XOAUTHIBITED"]) {
      await expect(
        resolveClientSecret("srv", `\${${name}}`, store, { [name]: "leak" }),
      ).rejects.toThrow(/not allowed/);
    }
  });

  it("treats lowercase ${name} as a literal (env refs are uppercase only)", async () => {
    // POSIX env vars are conventionally uppercase. The regex previously had
    // `/i`, which silently accepted lowercase names; dropping it means a
    // lowercase reference falls through to the plain-string branch — never
    // attempts env-var resolution.
    const value = await resolveClientSecret("srv", "${oauth_secret}", store, {
      oauth_secret: "leak",
    });
    expect(value).toBe("${oauth_secret}");
  });

  it("accepts conventional OAuth-related env-var names", async () => {
    for (const name of [
      "OAUTH_SECRET",
      "NOTION_OAUTH_SECRET",
      "MCP_BRIDGE_OAUTH_TOKEN",
      // OAuth2-style names that conventional provider docs publish.
      "GOOGLE_OAUTH2_CLIENT_SECRET",
      "OAUTH2_TOKEN",
      "XOAUTH2_BEARER",
    ]) {
      const value = await resolveClientSecret("srv", `\${${name}}`, store, {
        [name]: "ok",
      });
      expect(value).toBe("ok");
    }
  });

  it("works without a credential store", async () => {
    const secret = await resolveClientSecret(
      "notion",
      "${OAUTH_X}",
      undefined,
      { OAUTH_X: "value" },
    );
    expect(secret).toBe("value");
  });
});

describe("hasStoredOAuthCredential", () => {
  let store: CredentialStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("has-stored-oauth-"));
  });

  afterEach(() => {
    cleanup();
  });

  it("returns true when oauth:<name> is stored", async () => {
    await store.set(oauthCredentialKey("Linear"), {
      type: "oauth2",
      access_token: "at",
    });
    expect(await hasStoredOAuthCredential(store, "Linear")).toBe(true);
  });

  it("returns false when nothing is stored for the server", async () => {
    expect(await hasStoredOAuthCredential(store, "Linear")).toBe(false);
  });

  it("returns false when a non-oauth credential happens to share the key shape", async () => {
    // Defensive: only `type === "oauth2"` should flip the autodetect on.
    // A `secret`/`bearer` credential under the same prefix would be a bug
    // elsewhere, but make sure it doesn't accidentally enable OAuth here.
    await store.set(oauthCredentialKey("Linear"), {
      type: "bearer",
      access_token: "bearer-not-oauth",
    });
    expect(await hasStoredOAuthCredential(store, "Linear")).toBe(false);
  });
});

