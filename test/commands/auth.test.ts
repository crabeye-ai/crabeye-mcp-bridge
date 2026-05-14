import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import {
  BridgeConfigSchema,
  type BridgeConfig,
} from "../../src/config/schema.js";
import {
  runAuthList,
  runAuthLogin,
  runAuthRemove,
} from "../../src/commands/auth.js";
import {
  clientSecretKey,
  oauthCredentialKey,
} from "../../src/oauth/index.js";
import { makeTestStore } from "../_helpers/credential-store.js";

function makeConfig(): BridgeConfig {
  return BridgeConfigSchema.parse({
    mcpServers: {
      "notion": {
        type: "streamable-http",
        url: "https://notion.example.com/mcp",
        _bridge: {
          auth: {
            type: "oauth2",
            clientId: "client-1",
            endpoints: {
              authorization: "https://notion.example.com/authorize",
              token: "https://notion.example.com/token",
            },
            scopes: ["read", "write"],
          },
        },
      },
      "github": {
        type: "streamable-http",
        url: "https://github.example.com/mcp",
        _bridge: {
          auth: {
            type: "oauth2",
            clientId: "client-2",
          },
        },
      },
      // No `_bridge.auth` — will only appear in --list if discovery advertises OAuth.
      "plain": {
        type: "streamable-http",
        url: "https://plain.example.com/mcp",
      },
    },
  });
}

describe("runAuthList", () => {
  let store: CredentialStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("auth-list-"));
  });

  afterEach(() => {
    cleanup();
  });

  it("shows auth-required for configured servers with no stored credential", async () => {
    const out: string[] = [];
    const code = await runAuthList(
      {},
      {
        print: (l) => out.push(l),
        errPrint: (l) => out.push(l),
        store,
        loadConfig: async () => makeConfig(),
        // No discovery — only configured rows show up.
        discoverProtectedResource: async () => {
          throw new Error("no metadata");
        },
      },
    );
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/github\s+auth-required/);
    expect(text).toMatch(/notion\s+auth-required/);
    expect(text).not.toMatch(/plain/);
  });

  it("shows authenticated when a valid token is stored", async () => {
    await store.set(oauthCredentialKey("notion"), {
      type: "oauth2",
      access_token: "at",
      refresh_token: "rt",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const out: string[] = [];
    await runAuthList(
      {},
      {
        print: (l) => out.push(l),
        errPrint: (l) => out.push(l),
        store,
        loadConfig: async () => makeConfig(),
        discoverProtectedResource: async () => {
          throw new Error("no metadata");
        },
      },
    );
    expect(out.join("\n")).toMatch(/notion\s+authenticated/);
  });

  it("surfaces servers that advertise OAuth via RFC 9728 even without config", async () => {
    const out: string[] = [];
    await runAuthList(
      {},
      {
        print: (l) => out.push(l),
        errPrint: (l) => out.push(l),
        store,
        loadConfig: async () => makeConfig(),
        // Only `plain` advertises OAuth via discovery.
        discoverProtectedResource: (async (serverUrl: string | URL) => {
          if (String(serverUrl).includes("plain.example.com")) {
            return {
              resource: String(serverUrl),
              authorization_servers: ["https://auth.example.com"],
            };
          }
          throw new Error("no metadata");
        }) as never,
      },
    );
    const text = out.join("\n");
    expect(text).toMatch(/plain\s+advertises-oauth/);
    expect(text).toMatch(/notion\s+auth-required\s+.*\s+config/);
  });

  it("shows auth-required when expired and no refresh token", async () => {
    await store.set(oauthCredentialKey("notion"), {
      type: "oauth2",
      access_token: "at",
      expires_at: Math.floor(Date.now() / 1000) - 100,
    });
    const out: string[] = [];
    await runAuthList(
      {},
      {
        print: (l) => out.push(l),
        errPrint: (l) => out.push(l),
        store,
        loadConfig: async () => makeConfig(),
        discoverProtectedResource: async () => {
          throw new Error("no metadata");
        },
      },
    );
    expect(out.join("\n")).toMatch(/notion\s+auth-required/);
  });
});

describe("runAuthRemove", () => {
  let store: CredentialStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("auth-remove-"));
  });

  afterEach(() => {
    cleanup();
  });

  const noConfig = async (): Promise<BridgeConfig> => makeConfig();

  it("removes only the targeted server's credentials", async () => {
    await store.set(oauthCredentialKey("notion"), { type: "oauth2", access_token: "n" });
    await store.set(oauthCredentialKey("github"), { type: "oauth2", access_token: "g" });
    await store.set("some-other-key", { type: "secret", value: "keep-me" });

    const code = await runAuthRemove(
      "notion",
      {},
      { store, print: () => {}, errPrint: () => {}, loadConfig: noConfig },
    );
    expect(code).toBe(0);
    expect(await store.get(oauthCredentialKey("notion"))).toBeUndefined();
    expect(await store.get(oauthCredentialKey("github"))).toBeDefined();
    expect(await store.get("some-other-key")).toBeDefined();
  });

  it("also removes the companion client-secret and dynamic-client-info entries", async () => {
    await store.set(oauthCredentialKey("notion"), { type: "oauth2", access_token: "n" });
    await store.set(clientSecretKey("notion"), { type: "secret", value: "shh" });
    await store.set("oauth-client:notion", { type: "secret", value: '{"client_id":"dyn-x"}' });

    const code = await runAuthRemove(
      "notion",
      {},
      { store, print: () => {}, errPrint: () => {}, loadConfig: noConfig },
    );
    expect(code).toBe(0);
    expect(await store.get(oauthCredentialKey("notion"))).toBeUndefined();
    expect(await store.get(clientSecretKey("notion"))).toBeUndefined();
    expect(await store.get("oauth-client:notion")).toBeUndefined();
  });

  it("returns non-zero when no credential exists", async () => {
    const err: string[] = [];
    const code = await runAuthRemove(
      "missing",
      {},
      { store, print: () => {}, errPrint: (l) => err.push(l), loadConfig: noConfig },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/No stored credentials/);
  });

  it("encodes server names so colons can't collide with another server", async () => {
    await store.set(oauthCredentialKey("notion"), { type: "oauth2", access_token: "a" });
    await store.set(oauthCredentialKey("notion:beta"), { type: "oauth2", access_token: "b" });

    const code = await runAuthRemove(
      "notion",
      {},
      { store, print: () => {}, errPrint: () => {}, loadConfig: noConfig },
    );
    expect(code).toBe(0);
    expect(await store.get(oauthCredentialKey("notion"))).toBeUndefined();
    expect(await store.get(oauthCredentialKey("notion:beta"))).toBeDefined();
  });

  it("canonicalizes a case-mismatched server name against the config", async () => {
    // Stored under the canonical (config) name "notion".
    await store.set(oauthCredentialKey("notion"), { type: "oauth2", access_token: "n" });
    await store.set(clientSecretKey("notion"), { type: "secret", value: "shh" });

    const out: string[] = [];
    const code = await runAuthRemove(
      "NOTION", // user typed all-caps
      {},
      { store, print: (l) => out.push(l), errPrint: () => {}, loadConfig: noConfig },
    );
    expect(code).toBe(0);
    // Canonical name is what gets reported back to the user.
    expect(out.join("\n")).toMatch(/Removed local .* for "notion"/);
    expect(await store.get(oauthCredentialKey("notion"))).toBeUndefined();
    expect(await store.get(clientSecretKey("notion"))).toBeUndefined();
  });

  it("falls back to verbatim name when config is unavailable or the server is gone", async () => {
    // Server was once `legacy` and is no longer in config — we still want to
    // be able to clean up its stale credentials by typing the name exactly.
    await store.set(oauthCredentialKey("legacy"), { type: "oauth2", access_token: "x" });
    const code = await runAuthRemove(
      "legacy",
      {},
      { store, print: () => {}, errPrint: () => {}, loadConfig: noConfig },
    );
    expect(code).toBe(0);
    expect(await store.get(oauthCredentialKey("legacy"))).toBeUndefined();
  });
});

describe("runAuthLogin", () => {
  let store: CredentialStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("auth-login-"));
  });

  afterEach(() => {
    cleanup();
  });

  it("errors when target server is not configured", async () => {
    const err: string[] = [];
    const code = await runAuthLogin(
      { serverName: "unknown" },
      {
        store,
        print: () => {},
        errPrint: (l) => err.push(l),
        loadConfig: async () => makeConfig(),
      },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/not configured/);
  });

  it("errors when target server is stdio (HTTP required)", async () => {
    const stdioConfig = BridgeConfigSchema.parse({
      mcpServers: {
        stdio: { command: "node", args: ["server.js"] },
      },
    });
    const err: string[] = [];
    const code = await runAuthLogin(
      { serverName: "stdio" },
      {
        store,
        print: () => {},
        errPrint: (l) => err.push(l),
        loadConfig: async () => stdioConfig,
      },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/HTTP\/streamable-http/);
  });

  it("completes the SDK flow: REDIRECT → callback → AUTHORIZED, stores tokens", async () => {
    const out: string[] = [];
    const err: string[] = [];
    let openedUrl = "";

    // Fake callback server that resolves immediately on demand.
    let resolveCb!: (cb: { code: string; state: string }) => void;
    const cbPromise = new Promise<{ code: string; state: string }>((res) => { resolveCb = res; });

    let issuedState: string | undefined;
    let authCallCount = 0;
    const fakeAuth = async (
      provider: import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider,
      options: { serverUrl: string | URL; authorizationCode?: string },
    ): Promise<"AUTHORIZED" | "REDIRECT"> => {
      authCallCount++;
      if (options.authorizationCode === undefined) {
        // First call: SDK builds auth URL, asks provider to redirect, returns 'REDIRECT'.
        // Mirror what the real SDK does: pull state from the provider so the
        // CLI can verify the callback against the same value.
        // SDK types `state?` as `string | Promise<string>`. Our impl is sync.
        issuedState = await provider.state?.();
        await provider.redirectToAuthorization(
          new URL(`https://provider.example.com/authorize?state=${issuedState}`),
        );
        return "REDIRECT";
      }
      // Second call: SDK exchanges code, calls saveTokens, returns 'AUTHORIZED'.
      await provider.saveTokens({
        access_token: "at-final",
        token_type: "Bearer",
        refresh_token: "rt-final",
        expires_in: 3600,
        scope: "read write",
      });
      return "AUTHORIZED";
    };

    const result = runAuthLogin(
      { serverName: "notion" },
      {
        store,
        print: (l) => out.push(l),
        errPrint: (l) => err.push(l),
        loadConfig: async () => makeConfig(),
        startCallbackServer: async () => ({
          port: 12345,
          redirectUri: "http://127.0.0.1:12345/callback",
          result: cbPromise,
          close: async () => {},
        }),
        openBrowser: async (url: string) => {
          openedUrl = url;
          // Echo the state that the SDK actually issued so the CSRF check passes.
          resolveCb({ code: "auth-code", state: issuedState ?? "" });
          return true;
        },
        auth: fakeAuth as never,
      },
    );

    const code = await result;
    expect(code).toBe(0);
    expect(authCallCount).toBe(2);
    expect(openedUrl).toMatch(/^https:\/\/provider\.example\.com\/authorize/);
    expect(out.join("\n")).toMatch(/Authenticated "notion"/);
    // Verify the CSRF state actually round-tripped (not just that auth was
    // called twice). The base64url-encoded 32-byte random should be >=43
    // chars; require >20 for headroom.
    expect(issuedState).toBeDefined();
    expect(issuedState!.length).toBeGreaterThan(20);

    const stored = await store.get(oauthCredentialKey("notion"));
    expect(stored).toMatchObject({
      type: "oauth2",
      access_token: "at-final",
      refresh_token: "rt-final",
    });
  });

  it("matches the server name case-insensitively and writes tokens under the canonical key", async () => {
    const out: string[] = [];
    let resolveCb!: (cb: { code: string; state: string }) => void;
    const cbPromise = new Promise<{ code: string; state: string }>((res) => { resolveCb = res; });
    let issuedState: string | undefined;
    const fakeAuth = async (
      provider: import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider,
      options: { serverUrl: string | URL; authorizationCode?: string },
    ): Promise<"AUTHORIZED" | "REDIRECT"> => {
      if (options.authorizationCode === undefined) {
        // SDK types `state?` as `string | Promise<string>`. Our impl is sync.
        issuedState = await provider.state?.();
        await provider.redirectToAuthorization(
          new URL(`https://provider.example.com/authorize?state=${issuedState}`),
        );
        return "REDIRECT";
      }
      await provider.saveTokens({ access_token: "at-x", token_type: "Bearer" });
      return "AUTHORIZED";
    };

    const code = await runAuthLogin(
      // Config defines "notion"; user typed "NOTION".
      { serverName: "NOTION" },
      {
        store,
        print: (l) => out.push(l),
        errPrint: () => {},
        loadConfig: async () => makeConfig(),
        startCallbackServer: async () => ({
          port: 12345,
          redirectUri: "http://127.0.0.1:12345/callback",
          result: cbPromise,
          close: async () => {},
        }),
        openBrowser: async () => {
          resolveCb({ code: "auth-code", state: issuedState ?? "" });
          return true;
        },
        auth: fakeAuth as never,
      },
    );

    expect(code).toBe(0);
    // Stored under the canonical "notion", not "NOTION".
    expect(await store.get(oauthCredentialKey("notion"))).toBeDefined();
    expect(await store.get(oauthCredentialKey("NOTION"))).toBeUndefined();
    // Success message uses canonical name.
    expect(out.join("\n")).toMatch(/Authenticated "notion"/);
  });

  it("refuses to open the browser on a non-HTTPS authorization URL", async () => {
    const err: string[] = [];
    const fakeAuth = async (
      provider: import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider,
    ): Promise<"AUTHORIZED" | "REDIRECT"> => {
      // SDK derives this URL from discovery — a compromised metadata response
      // or a tampered config could plausibly hand us plain http. The provider
      // throws via `onRedirect`, which is what we want to surface.
      await provider.redirectToAuthorization(new URL("http://attacker.example/authorize"));
      return "REDIRECT";
    };
    let browserCalled = false;
    const code = await runAuthLogin(
      { serverName: "notion" },
      {
        store,
        print: () => {},
        errPrint: (l) => err.push(l),
        loadConfig: async () => makeConfig(),
        startCallbackServer: async () => ({
          port: 12345,
          redirectUri: "http://127.0.0.1:12345/callback",
          result: new Promise(() => {}),
          close: async () => {},
        }),
        openBrowser: async () => { browserCalled = true; return true; },
        auth: fakeAuth as never,
      },
    );
    expect(code).toBe(1);
    expect(browserCalled).toBe(false);
    expect(err.join("\n")).toMatch(/Authorization endpoint must use https/i);
  });

  it("rejects callback when state does not match issued state (CSRF)", async () => {
    const err: string[] = [];
    let resolveCb!: (cb: { code: string; state: string }) => void;
    const cbPromise = new Promise<{ code: string; state: string }>((res) => { resolveCb = res; });

    const fakeAuth = async (
      provider: import("@modelcontextprotocol/sdk/client/auth.js").OAuthClientProvider,
      options: { serverUrl: string | URL; authorizationCode?: string },
    ): Promise<"AUTHORIZED" | "REDIRECT"> => {
      if (options.authorizationCode === undefined) {
        // Force state generation, then drop the value on the floor so the
        // attacker-supplied callback below can't match.
        provider.state?.();
        await provider.redirectToAuthorization(new URL("https://provider.example.com/authorize"));
        return "REDIRECT";
      }
      throw new Error("auth() should not be called for code exchange when state mismatches");
    };

    const code = await runAuthLogin(
      { serverName: "notion" },
      {
        store,
        print: () => {},
        errPrint: (l) => err.push(l),
        loadConfig: async () => makeConfig(),
        startCallbackServer: async () => ({
          port: 12345,
          redirectUri: "http://127.0.0.1:12345/callback",
          result: cbPromise,
          close: async () => {},
        }),
        openBrowser: async () => {
          resolveCb({ code: "attacker-code", state: "not-the-real-state" });
          return true;
        },
        auth: fakeAuth as never,
      },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/state mismatch/i);
    // Tokens were never saved.
    expect(await store.get(oauthCredentialKey("notion"))).toBeUndefined();
  });

  it("short-circuits when already AUTHORIZED on first call (cached tokens)", async () => {
    const out: string[] = [];
    const code = await runAuthLogin(
      { serverName: "notion" },
      {
        store,
        print: (l) => out.push(l),
        errPrint: () => {},
        loadConfig: async () => makeConfig(),
        startCallbackServer: async () => ({
          port: 12345,
          redirectUri: "http://127.0.0.1:12345/callback",
          result: new Promise(() => {}),
          close: async () => {},
        }),
        openBrowser: async () => true,
        auth: (async () => "AUTHORIZED") as never,
      },
    );
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/Already authenticated/);
  });

  it("surfaces errors thrown from auth() cleanly", async () => {
    const err: string[] = [];
    const code = await runAuthLogin(
      { serverName: "notion" },
      {
        store,
        print: () => {},
        errPrint: (l) => err.push(l),
        loadConfig: async () => makeConfig(),
        startCallbackServer: async () => ({
          port: 12345,
          redirectUri: "http://127.0.0.1:12345/callback",
          result: new Promise(() => {}),
          close: async () => {},
        }),
        openBrowser: async () => true,
        auth: (async () => {
          throw new Error("token endpoint unreachable");
        }) as never,
      },
    );
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/token endpoint unreachable/);
  });
});
