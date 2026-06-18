import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import type { Credential } from "../../src/credentials/types.js";
import {
  BridgeOAuthClientProvider,
  makeOriginPinningFetch,
} from "../../src/oauth/sdk-provider.js";
import { OAuthError } from "../../src/oauth/errors.js";
import { oauthCredentialKey } from "../../src/oauth/index.js";
import { makeTestStore } from "../_helpers/credential-store.js";

const REDIRECT = "http://127.0.0.1:54321/callback";

describe("BridgeOAuthClientProvider", () => {
  let store: CredentialStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("sdk-provider-"));
  });

  afterEach(() => {
    cleanup();
  });

  it("clientMetadata reflects redirect, scopes, and confidential-client flag", () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
      clientSecret: "shh",
      scopes: ["read", "write"],
    });
    const meta = provider.clientMetadata;
    expect(meta.redirect_uris).toEqual([REDIRECT]);
    expect(meta.scope).toBe("read write");
    expect(meta.token_endpoint_auth_method).toBe("client_secret_post");
    expect(meta.grant_types).toContain("authorization_code");
    expect(meta.grant_types).toContain("refresh_token");
  });

  it("public-client metadata uses token_endpoint_auth_method=none", () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
  });

  it("clientInformation returns config-supplied client when set", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
      clientSecret: "shh",
    });
    const info = await provider.clientInformation();
    expect(info).toEqual({ client_id: "ci", client_secret: "shh" });
  });

  it("clientInformation falls back to stored dynamic registration", async () => {
    await store.set(`oauth-client:${encodeURIComponent("srv")}`, {
      type: "secret",
      value: JSON.stringify({ client_id: "dyn-1", client_secret: "dyn-shh" }),
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
    });
    const info = await provider.clientInformation();
    expect(info).toEqual({ client_id: "dyn-1", client_secret: "dyn-shh" });
  });

  it("saveClientInformation persists JSON to the encrypted store", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
    });
    await provider.saveClientInformation({
      client_id: "registered-id",
      client_secret: "registered-secret",
    });
    const info = await provider.clientInformation();
    expect(info).toEqual({
      client_id: "registered-id",
      client_secret: "registered-secret",
    });
  });

  it("tokens() translates expires_at → expires_in based on the wall clock", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    await store.set(oauthCredentialKey("srv"), {
      type: "oauth2",
      access_token: "at",
      refresh_token: "rt",
      expires_at: expiresAt,
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    const tokens = await provider.tokens();
    expect(tokens?.access_token).toBe("at");
    expect(tokens?.refresh_token).toBe("rt");
    expect(tokens?.token_type).toBe("Bearer");
    // Allow a few seconds of clock drift between save and read.
    expect(tokens?.expires_in).toBeGreaterThan(595);
    expect(tokens?.expires_in).toBeLessThanOrEqual(600);
  });

  it("saveTokens stores SDK shape as our internal OAuth2 credential", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    await provider.saveTokens({
      access_token: "at",
      token_type: "Bearer",
      refresh_token: "rt",
      expires_in: 1800,
    });
    const stored = await store.get(oauthCredentialKey("srv"));
    expect(stored).toMatchObject({
      type: "oauth2",
      access_token: "at",
      refresh_token: "rt",
      client_id: "ci",
    });
    // expires_at = now + 1800 (±2s margin for the round-trip)
    if (stored?.type === "oauth2" && stored.expires_at !== undefined) {
      const drift = stored.expires_at - (Math.floor(Date.now() / 1000) + 1800);
      expect(Math.abs(drift)).toBeLessThanOrEqual(2);
    }
  });

  it("redirectToAuthorization throws an actionable reauth message when no onRedirect (runtime)", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    // Both the permanent-refresh-failure path (SDK retries after
    // InvalidGrantError, finds no refresh_token, falls into redirect) and
    // the circuit-breaker trip (tokens() returns undefined) funnel here.
    // The error message must name the server and the exact CLI command.
    await expect(
      provider.redirectToAuthorization(new URL("https://provider/auth?state=x")),
    ).rejects.toThrow(/Authentication for "srv" expired.*mcp-bridge auth srv/);
  });

  it("saveTokens preserves the stored refresh_token when the SDK omits it", async () => {
    // Common with IdPs that don't rotate refresh tokens (Google, Slack):
    // the refresh response carries only `access_token`. Overwriting the
    // stored credential with no refresh_token would force re-auth.
    await store.set(oauthCredentialKey("srv"), {
      type: "oauth2",
      access_token: "old-at",
      refresh_token: "preserved-rt",
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    // The SDK calls `tokens()` before every refresh attempt; that's where
    // the in-provider cache of refresh_token gets populated. Mirror that
    // sequence here.
    await provider.tokens();
    await provider.saveTokens({
      access_token: "new-at",
      token_type: "Bearer",
      expires_in: 1800,
    });
    const stored = await store.get(oauthCredentialKey("srv"));
    expect(stored).toMatchObject({
      type: "oauth2",
      access_token: "new-at",
      refresh_token: "preserved-rt",
    });
  });

  it("saveTokens overwrites refresh_token when the SDK supplies a rotated one", async () => {
    await store.set(oauthCredentialKey("srv"), {
      type: "oauth2",
      access_token: "old-at",
      refresh_token: "old-rt",
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    await provider.saveTokens({
      access_token: "new-at",
      token_type: "Bearer",
      refresh_token: "rotated-rt",
      expires_in: 1800,
    });
    const stored = await store.get(oauthCredentialKey("srv"));
    expect(stored).toMatchObject({
      type: "oauth2",
      access_token: "new-at",
      refresh_token: "rotated-rt",
    });
  });

  it("redirectToAuthorization invokes onRedirect when configured (CLI context)", async () => {
    let seen: URL | undefined;
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
      onRedirect: async (url) => { seen = url; },
    });
    await provider.redirectToAuthorization(new URL("https://provider/auth?state=x"));
    expect(seen?.toString()).toBe("https://provider/auth?state=x");
  });

  it("PKCE verifier round-trips in memory", () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    expect(() => provider.codeVerifier()).toThrow(/verifier missing/);
    provider.saveCodeVerifier("test-verifier-123");
    expect(provider.codeVerifier()).toBe("test-verifier-123");
  });

  it("invalidateCredentials('tokens') deletes only the token entry", async () => {
    await store.set(oauthCredentialKey("srv"), { type: "oauth2", access_token: "at" });
    await store.set(`oauth-client:${encodeURIComponent("srv")}`, {
      type: "secret",
      value: JSON.stringify({ client_id: "dyn-1" }),
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
    });
    await provider.invalidateCredentials("tokens");
    expect(await store.get(oauthCredentialKey("srv"))).toBeUndefined();
    expect(await store.get(`oauth-client:${encodeURIComponent("srv")}`)).toBeDefined();
  });

  it("invalidateCredentials('client') leaves a config-supplied client alone", async () => {
    await store.set(`oauth-client:${encodeURIComponent("srv")}`, {
      type: "secret",
      value: JSON.stringify({ client_id: "dyn-1" }),
    });
    // Config supplies a clientId — invalidation must NOT touch the stored
    // dynamic registration in this case (config wins, and we don't want to
    // surprise-delete state that the user couldn't have caused).
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "config-supplied",
    });
    await provider.invalidateCredentials("client");
    expect(await store.get(`oauth-client:${encodeURIComponent("srv")}`)).toBeDefined();
  });

  it("state() generates a stable random value and exposes it via expectedState()", () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    expect(provider.expectedState()).toBeUndefined();
    const first = provider.state();
    expect(first).toMatch(/^[A-Za-z0-9_-]{16,}$/); // base64url, >=16 chars
    expect(provider.state()).toBe(first); // memoised
    expect(provider.expectedState()).toBe(first);
  });

  it("invalidateCredentials('all') clears the issued state", () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    provider.state();
    expect(provider.expectedState()).toBeDefined();
    return provider.invalidateCredentials("all").then(() => {
      expect(provider.expectedState()).toBeUndefined();
    });
  });

  it("invalidateCredentials('verifier') preserves issued state for the in-flight CLI flow", async () => {
    // The SDK calls `invalidateCredentials('verifier')` on token-endpoint
    // errors during code exchange. If that wiped `_state`, the surrounding
    // CLI would surface the unrelated failure as a confusing "state mismatch".
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    const issued = provider.state();
    provider.saveCodeVerifier("v1");
    await provider.invalidateCredentials("verifier");
    expect(provider.expectedState()).toBe(issued);
    expect(() => provider.codeVerifier()).toThrow(/verifier missing/);
  });

  it("runtime provider refuses dynamic client registration", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: "http://127.0.0.1/callback",
      runtime: true,
    });
    await expect(
      provider.saveClientInformation({ client_id: "dyn-runtime" }),
    ).rejects.toThrow(/Dynamic client registration is not available at runtime.*mcp-bridge auth srv/i);
  });

  it("tokens() returns undefined when access token is expired and no refresh token", async () => {
    await store.set(oauthCredentialKey("srv"), {
      type: "oauth2",
      access_token: "stale",
      expires_at: Math.floor(Date.now() / 1000) - 100,
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    expect(await provider.tokens()).toBeUndefined();
  });

  it("tokens() preserves non-Bearer token_type", async () => {
    await store.set(oauthCredentialKey("srv"), {
      type: "oauth2",
      access_token: "tok",
      token_type: "DPoP",
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    const t = await provider.tokens();
    expect(t?.token_type).toBe("DPoP");
  });

  it("saveTokens persists token_type when supplied by the SDK", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    await provider.saveTokens({
      access_token: "at",
      token_type: "DPoP",
    });
    const stored = await store.get(oauthCredentialKey("srv"));
    expect(stored).toMatchObject({ type: "oauth2", access_token: "at", token_type: "DPoP" });
  });

  it("clientInformation self-heals on corrupt stored JSON", async () => {
    await store.set(`oauth-client:${encodeURIComponent("srv")}`, {
      type: "secret",
      value: "{not-json",
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
    });
    expect(await provider.clientInformation()).toBeUndefined();
    // Corrupt entry was dropped — subsequent lookup also returns undefined,
    // but the underlying store no longer holds the bad value.
    expect(await store.get(`oauth-client:${encodeURIComponent("srv")}`)).toBeUndefined();
  });

  describe("wrapFetch refresh-token coalescing", () => {
    function refreshInit(rt = "rt-1"): RequestInit {
      return {
        method: "POST",
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt }),
      };
    }

    it("coalesces N concurrent refresh POSTs into a single base fetch call", async () => {
      const provider = new BridgeOAuthClientProvider({
        serverName: "srv",
        store,
        redirectUrl: REDIRECT,
        clientId: "ci",
        runtime: true,
      });

      let calls = 0;
      let resolveBase: ((res: Response) => void) | undefined;
      const base: typeof fetch = async () => {
        calls++;
        // Block the in-flight HTTP call so all callers pile up on the
        // shared promise before any of them resolves.
        return new Promise<Response>((resolve) => {
          resolveBase = resolve;
        });
      };
      const wrapped = provider.wrapFetch(base);

      const N = 5;
      const inflight = Array.from({ length: N }, () =>
        wrapped("https://as.example/token", refreshInit()),
      );
      // Give the coalesce code a tick to register all N awaiters.
      await new Promise((r) => setTimeout(r, 0));
      expect(calls).toBe(1);

      resolveBase?.(
        new Response(
          JSON.stringify({ access_token: "new", token_type: "Bearer", expires_in: 60 }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const responses = await Promise.all(inflight);
      expect(responses).toHaveLength(N);
      // Each caller gets its own readable body — cloning is mandatory.
      for (const r of responses) {
        expect(r.status).toBe(200);
        const json = (await r.json()) as { access_token: string };
        expect(json.access_token).toBe("new");
      }
    });

    it("does not coalesce non-refresh requests", async () => {
      const provider = new BridgeOAuthClientProvider({
        serverName: "srv",
        store,
        redirectUrl: REDIRECT,
        clientId: "ci",
      });
      let calls = 0;
      const base: typeof fetch = async () => {
        calls++;
        return new Response("ok", { status: 200 });
      };
      const wrapped = provider.wrapFetch(base);
      // GET — not a refresh
      await wrapped("https://example/anything", { method: "GET" });
      // POST with a different grant — not a refresh
      await wrapped("https://example/token", {
        method: "POST",
        body: new URLSearchParams({ grant_type: "authorization_code" }),
      });
      expect(calls).toBe(2);
    });

    it("allows a fresh refresh after the in-flight one settles", async () => {
      const provider = new BridgeOAuthClientProvider({
        serverName: "srv",
        store,
        redirectUrl: REDIRECT,
        clientId: "ci",
      });
      let calls = 0;
      const base: typeof fetch = async () => {
        calls++;
        return new Response(
          JSON.stringify({ access_token: `at-${calls}`, token_type: "Bearer" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };
      const wrapped = provider.wrapFetch(base);
      await wrapped("https://as/token", refreshInit());
      await wrapped("https://as/token", refreshInit());
      // Two SEQUENTIAL refreshes are independent and each hit the IdP — we
      // only coalesce overlapping in-flight calls, not back-to-back ones.
      expect(calls).toBe(2);
    });

    it("propagates baseFetch rejection to every coalesced awaiter", async () => {
      const provider = new BridgeOAuthClientProvider({
        serverName: "srv",
        store,
        redirectUrl: REDIRECT,
        clientId: "ci",
      });
      const err = new Error("token endpoint exploded");
      const base: typeof fetch = async () => {
        // Microtask-defer so multiple wrapped() callers register before the
        // promise settles.
        await Promise.resolve();
        throw err;
      };
      const wrapped = provider.wrapFetch(base);
      const a = wrapped("https://as/token", refreshInit()).catch((e) => e);
      const b = wrapped("https://as/token", refreshInit()).catch((e) => e);
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra).toBe(err);
      expect(rb).toBe(err);
    });
  });

  describe("refresh_token cache (#185)", () => {
    const KEY = oauthCredentialKey("srv");

    const makeProvider = (storeArg: CredentialStore = store): BridgeOAuthClientProvider =>
      new BridgeOAuthClientProvider({
        serverName: "srv",
        store: storeArg,
        redirectUrl: REDIRECT,
        clientId: "ci",
      });

    const refreshTokenOf = (c: Credential | undefined): string | undefined =>
      c?.type === "oauth2" ? c.refresh_token : undefined;

    it("tokens() populates the cache so a later saveTokens without refresh_token preserves it", async () => {
      await store.set(KEY, {
        type: "oauth2",
        access_token: "old-at",
        refresh_token: "cached-rt",
      });
      const provider = makeProvider();
      await provider.tokens();
      await provider.saveTokens({
        access_token: "new-at",
        token_type: "Bearer",
        expires_in: 1800,
      });
      expect(await store.get(KEY)).toMatchObject({
        type: "oauth2",
        access_token: "new-at",
        refresh_token: "cached-rt",
      });
    });

    it("saveTokens before tokens() with refresh_token in payload writes that refresh_token (initial auth)", async () => {
      // Empty store, no `tokens()` call — cache is undefined. Initial
      // authorization always carries a refresh_token, so the payload wins.
      const provider = makeProvider();
      await provider.saveTokens({
        access_token: "at",
        token_type: "Bearer",
        refresh_token: "fresh-rt",
        expires_in: 1800,
      });
      expect(await store.get(KEY)).toMatchObject({
        type: "oauth2",
        access_token: "at",
        refresh_token: "fresh-rt",
      });
    });

    it("saveTokens before tokens() with no refresh_token writes no refresh_token", async () => {
      // Pathological — the SDK shouldn't drive this sequence, but if no
      // payload refresh_token and no cache, we don't fabricate one.
      const provider = makeProvider();
      await provider.saveTokens({
        access_token: "at",
        token_type: "Bearer",
        expires_in: 1800,
      });
      const stored = await store.get(KEY);
      expect(stored).toMatchObject({ type: "oauth2", access_token: "at" });
      expect(refreshTokenOf(stored)).toBeUndefined();
    });

    it("back-to-back saveTokens with no intervening tokens() preserves the cached refresh_token across both saves", async () => {
      await store.set(KEY, {
        type: "oauth2",
        access_token: "at-0",
        refresh_token: "rt-0",
      });
      const provider = makeProvider();
      await provider.tokens(); // populate cache once

      await provider.saveTokens({
        access_token: "at-1",
        token_type: "Bearer",
        expires_in: 1800,
      });
      await provider.saveTokens({
        access_token: "at-2",
        token_type: "Bearer",
        expires_in: 1800,
      });

      expect(await store.get(KEY)).toMatchObject({
        type: "oauth2",
        access_token: "at-2",
        refresh_token: "rt-0",
      });
    });

    it("saveTokens with a rotated refresh_token updates the cache to the rotated value", async () => {
      await store.set(KEY, {
        type: "oauth2",
        access_token: "at-0",
        refresh_token: "rt-0",
      });
      const provider = makeProvider();
      await provider.tokens(); // cache = rt-0

      // Rotation: payload carries rt-1.
      await provider.saveTokens({
        access_token: "at-1",
        token_type: "Bearer",
        refresh_token: "rt-1",
        expires_in: 1800,
      });

      // Next save omits refresh_token — should preserve rt-1 (the rotated
      // value), not the original rt-0.
      await provider.saveTokens({
        access_token: "at-2",
        token_type: "Bearer",
        expires_in: 1800,
      });

      expect(await store.get(KEY)).toMatchObject({
        type: "oauth2",
        access_token: "at-2",
        refresh_token: "rt-1",
      });
    });

    it("invalidateCredentials('tokens') clears the cache so the next saveTokens without payload writes no refresh_token", async () => {
      await store.set(KEY, {
        type: "oauth2",
        access_token: "old-at",
        refresh_token: "rt-pre",
      });
      const provider = makeProvider();
      await provider.tokens(); // cache = rt-pre

      await provider.invalidateCredentials("tokens");

      // Without the fix, the cache would still hold rt-pre and resurrect
      // the credential with the just-invalidated refresh_token.
      await provider.saveTokens({
        access_token: "new-at",
        token_type: "Bearer",
        expires_in: 1800,
      });
      const stored = await store.get(KEY);
      expect(stored).toMatchObject({ type: "oauth2", access_token: "new-at" });
      expect(refreshTokenOf(stored)).toBeUndefined();
    });

    it("invalidateCredentials('all') clears the cache", async () => {
      await store.set(KEY, {
        type: "oauth2",
        access_token: "at",
        refresh_token: "rt",
      });
      const provider = makeProvider();
      await provider.tokens(); // cache = rt
      await provider.invalidateCredentials("all");
      await provider.saveTokens({
        access_token: "new-at",
        token_type: "Bearer",
        expires_in: 1800,
      });
      expect(refreshTokenOf(await store.get(KEY))).toBeUndefined();
    });

    it.each(["client", "verifier", "discovery"] as const)(
      "invalidateCredentials(%s) does NOT clear the cache",
      async (scope) => {
        await store.set(KEY, {
          type: "oauth2",
          access_token: "at",
          refresh_token: "kept-rt",
        });
        const provider = makeProvider();
        await provider.tokens();
        await provider.invalidateCredentials(scope);
        await provider.saveTokens({
          access_token: "new-at",
          token_type: "Bearer",
          expires_in: 1800,
        });
        expect(await store.get(KEY)).toMatchObject({
          refresh_token: "kept-rt",
        });
      },
    );

    it("invalidate-then-save: invalidate's sync clear lands before saveTokens reads the cache", async () => {
      // The regression guard. Before the fix, saveTokens read the stored
      // credential via async `store.get`, and a concurrent invalidate could
      // delete between the get and the set — letting saveTokens write a
      // credential carrying the just-invalidated refresh_token. With the
      // cache the read is a sync field access; invalidate's sync clear runs
      // first and saveTokens captures `undefined`.
      await store.set(KEY, {
        type: "oauth2",
        access_token: "old-at",
        refresh_token: "rt-doomed",
      });
      const provider = makeProvider();
      await provider.tokens(); // cache = rt-doomed

      // Fire invalidate first so its sync cache clear lands before
      // saveTokens reads the cache. Both writes then serialise on the
      // credential-store mutex.
      const invalidatePromise = provider.invalidateCredentials("tokens");
      const savePromise = provider.saveTokens({
        access_token: "new-at",
        token_type: "Bearer",
        expires_in: 1800,
      });
      await Promise.all([invalidatePromise, savePromise]);

      // saveTokens runs second under the mutex, so the credential exists
      // and carries the new access_token — but NOT a resurrected
      // refresh_token, because the cache was cleared synchronously before
      // saveTokens read it.
      const stored = await store.get(KEY);
      expect(stored).toMatchObject({ type: "oauth2", access_token: "new-at" });
      expect(refreshTokenOf(stored)).toBeUndefined();
    });

    it("tokens() racing invalidate does not resurrect a just-cleared cache", async () => {
      // Regression for the M1 finding (#185 security review). Before the
      // invalidate-epoch guard, `tokens()` would await `store.get` (which
      // bypasses the file mutex on reads), and a concurrent
      // `invalidateCredentials("tokens")` could clear the cache and delete
      // the credential — but the pre-delete `get` result, resolving later,
      // would write the stale refresh_token back into the just-cleared
      // cache. A follow-up saveTokens without a payload refresh_token would
      // then resurrect it on disk.
      await store.set(KEY, {
        type: "oauth2",
        access_token: "old-at",
        refresh_token: "rt-ghost",
      });

      // Wrap the store to slow `get` so we can interleave invalidate
      // deterministically while `tokens()` is mid-await.
      let releaseGet: () => void = () => {};
      const slowGetPromise = new Promise<void>((r) => { releaseGet = r; });
      const realGet = store.get.bind(store);
      const slowStore = new Proxy(store, {
        get(target, prop, receiver) {
          if (prop === "get") {
            return async (key: string) => {
              const result = await realGet(key);
              await slowGetPromise;
              return result;
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const provider = makeProvider(slowStore);

      // Start `tokens()` — its `await store.get` resolves the real read but
      // then blocks on `slowGetPromise` before assigning the cache.
      const tokensPromise = provider.tokens();
      // While `tokens()` is parked past the await, invalidate runs to
      // completion: bumps epoch, clears cache, deletes credential.
      await provider.invalidateCredentials("tokens");
      // Now unblock `tokens()`. Its post-await branch sees the epoch has
      // changed and skips the cache write.
      releaseGet();
      await tokensPromise;

      // A subsequent saveTokens that omits refresh_token must NOT pull a
      // resurrected value from the cache.
      await provider.saveTokens({
        access_token: "new-at",
        token_type: "Bearer",
        expires_in: 1800,
      });
      const stored = await store.get(KEY);
      expect(stored).toMatchObject({ type: "oauth2", access_token: "new-at" });
      expect(refreshTokenOf(stored)).toBeUndefined();
    });
  });
});

describe("makeOriginPinningFetch", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("passes through metadata when token and authorization origins match", async () => {
    const base = async (): Promise<Response> =>
      jsonResponse({
        authorization_endpoint: "https://as.example.com/authorize",
        token_endpoint: "https://as.example.com/token",
      });
    const guarded = makeOriginPinningFetch(base as unknown as typeof fetch);
    const res = await guarded("https://as.example.com/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    // Original body still readable.
    const body = (await res.json()) as { authorization_endpoint: string };
    expect(body.authorization_endpoint).toBe("https://as.example.com/authorize");
  });

  it("throws OAuthError when token endpoint origin diverges from authorization endpoint", async () => {
    const base = async (): Promise<Response> =>
      jsonResponse({
        authorization_endpoint: "https://as.example.com/authorize",
        token_endpoint: "https://attacker.example/token",
      });
    const guarded = makeOriginPinningFetch(base as unknown as typeof fetch);
    await expect(
      guarded("https://as.example.com/.well-known/oauth-authorization-server"),
    ).rejects.toBeInstanceOf(OAuthError);
    await expect(
      guarded("https://as.example.com/.well-known/oauth-authorization-server"),
    ).rejects.toThrow(/attacker\.example.*as\.example\.com/);
  });

  it("ignores non-JSON responses", async () => {
    const base = async (): Promise<Response> =>
      new Response("not json", { status: 200, headers: { "Content-Type": "text/plain" } });
    const guarded = makeOriginPinningFetch(base as unknown as typeof fetch);
    const res = await guarded("https://as.example.com/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
  });

  it("passes through responses without both endpoint fields", async () => {
    const base = async (): Promise<Response> => jsonResponse({ unrelated: "shape" });
    const guarded = makeOriginPinningFetch(base as unknown as typeof fetch);
    const res = await guarded("https://as.example.com/anything");
    expect(res.status).toBe(200);
  });

  it("passes through non-OK responses without inspecting body", async () => {
    const base = async (): Promise<Response> =>
      new Response("server error", {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    const guarded = makeOriginPinningFetch(base as unknown as typeof fetch);
    const res = await guarded("https://as.example.com/anything");
    expect(res.status).toBe(500);
  });
});
