import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
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

  it("redirectToAuthorization throws when no onRedirect (runtime context)", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    await expect(
      provider.redirectToAuthorization(new URL("https://provider/auth?state=x")),
    ).rejects.toThrow(/mcp-bridge auth srv/);
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
