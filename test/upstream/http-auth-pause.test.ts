import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IssuerMismatchError, OAuthError as SdkOAuthError } from "@modelcontextprotocol/client";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { clientInfoKey, oauthCredentialKey } from "../../src/oauth/client-secret.js";
import type { HttpServerConfig } from "../../src/config/schema.js";
import type { ConnectionStatus } from "../../src/upstream/types.js";
import { makeTestStore, type TestStoreHandle } from "../_helpers/credential-store.js";
import { startProtectedUpstream, type ProtectedUpstream, type TokenEndpoint } from "../_helpers/protected-upstream.js";

describe("HTTP upstream authorization pause (real OAuth provider)", () => {
  let storeHandle: TestStoreHandle;
  let upstream: ProtectedUpstream | undefined;
  let client: HttpUpstreamClient | undefined;

  beforeEach(() => {
    storeHandle = makeTestStore("crabeye-auth-pause-");
  });

  afterEach(async () => {
    await client?.close();
    await upstream?.close();
    client = undefined;
    upstream = undefined;
    storeHandle.cleanup();
  });

  async function storeExpiredTokens(): Promise<void> {
    await storeHandle.store.set(oauthCredentialKey("protected"), {
      type: "oauth2",
      access_token: "expired",
      refresh_token: "refresh-me",
      expires_at: Math.floor(Date.now() / 1000) - 60,
    });
  }

  function makeClient(config: HttpServerConfig): HttpUpstreamClient {
    return new HttpUpstreamClient({
      name: "protected",
      config,
      credentialStore: storeHandle.store,
      reconnectBaseDelay: 100,
      reconnectMaxDelay: 1_000,
    });
  }

  async function settle(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  it("pauses when no tokens are stored", async () => {
    upstream = await startProtectedUpstream("invalid_grant");
    client = makeClient({ type: "streamable-http", url: upstream.url, _bridge: { auth: { type: "oauth2", clientId: "ci" } } });

    await client.connect().catch(() => {});
    const requests = upstream.mcpRequests();
    await settle(500);

    expect(client.status).toBe("auth_required");
    expect(upstream.mcpRequests()).toBe(requests);
  });

  it("pauses when the refresh token is rejected with invalid_grant", async () => {
    upstream = await startProtectedUpstream("invalid_grant");
    await storeExpiredTokens();
    client = makeClient({ type: "streamable-http", url: upstream.url, _bridge: { auth: { type: "oauth2", clientId: "ci" } } });

    await client.connect().catch(() => {});
    const requests = upstream.mcpRequests();
    await settle(500);

    expect(client.status).toBe("auth_required");
    expect(upstream.mcpRequests()).toBe(requests);
  });

  it.each<[string, TokenEndpoint]>([
    ["is temporarily unavailable", "unavailable"],
    ["rate-limits the refresh with an OAuth-style error body", "rate_limited_json"],
    ["answers 503 with a JSON error body", "unavailable_json"],
  ])("keeps retrying when the token endpoint %s", async (_label, tokenEndpoint) => {
    upstream = await startProtectedUpstream(tokenEndpoint);
    await storeExpiredTokens();
    client = makeClient({ type: "streamable-http", url: upstream.url, _bridge: { auth: { type: "oauth2", clientId: "ci" } } });

    await client.connect().catch(() => {});
    const requests = upstream.mcpRequests();
    await settle(500);

    expect(client.status).not.toBe("auth_required");
    expect(upstream.mcpRequests()).toBeGreaterThan(requests);
  });

  it("stays paused for an auto-detected OAuth upstream after its tokens were invalidated", async () => {
    upstream = await startProtectedUpstream("invalid_grant");
    await storeExpiredTokens();
    await storeHandle.store.set(clientInfoKey("protected"), {
      type: "secret",
      value: JSON.stringify({ client_id: "registered", redirect_uris: ["http://127.0.0.1/callback"] }),
    });
    client = makeClient({ type: "streamable-http", url: upstream.url });

    await client.connect().catch(() => {});
    expect(client.status).toBe("auth_required");

    await settle(150);
    await client.retryNow();
    const requests = upstream.mcpRequests();
    await settle(500);

    expect(client.status).toBe("auth_required");
    expect(upstream.mcpRequests()).toBe(requests);
  });

  it("reconnects on the next retry once valid credentials are stored", async () => {
    upstream = await startProtectedUpstream("invalid_grant");
    client = makeClient({ type: "streamable-http", url: upstream.url, _bridge: { auth: { type: "oauth2", clientId: "ci" } } });
    await client.connect().catch(() => {});
    expect(client.status).toBe("auth_required");

    await storeHandle.store.set(oauthCredentialKey("protected"), { type: "oauth2", access_token: "valid" });
    await settle(150);
    await client.retryNow();

    expect(client.status).toBe("connected");
  });

  it("pauses when the upstream demands a wider scope than the stored token has", async () => {
    upstream = await startProtectedUpstream("invalid_grant", "insufficient_scope");
    await storeHandle.store.set(oauthCredentialKey("protected"), {
      type: "oauth2",
      access_token: "valid",
      refresh_token: "refresh-me",
    });
    client = makeClient({ type: "streamable-http", url: upstream.url, _bridge: { auth: { type: "oauth2", clientId: "ci" } } });

    await client.connect().catch(() => {});
    const requests = upstream.mcpRequests();
    await settle(500);

    expect(client.status).toBe("auth_required");
    expect(upstream.mcpRequests()).toBe(requests);
  });

  it.each<[string, TokenEndpoint, ConnectionStatus]>([
    ["is rate-limited", "rate_limited_json", "connected"],
    ["is rejected with invalid_grant", "invalid_grant", "auth_required"],
  ])("a connected upstream whose token expires and whose refresh %s ends up %s", async (_label, refreshOutcome, expected) => {
    upstream = await startProtectedUpstream("invalid_grant");
    await storeHandle.store.set(oauthCredentialKey("protected"), {
      type: "oauth2",
      access_token: "valid",
      refresh_token: "refresh-me",
    });
    client = makeClient({ type: "streamable-http", url: upstream.url, _bridge: { auth: { type: "oauth2", clientId: "ci" } } });
    await client.connect();
    expect(client.status).toBe("connected");

    upstream.expireAccessToken(refreshOutcome);
    await expect(client.callTool({ name: "anything" })).rejects.toThrow();

    expect(client.status).toBe(expected);
  });

  it("treats a definitive authorization failure as one even after a transient refresh failure", () => {
    client = makeClient({ type: "streamable-http", url: "http://127.0.0.1:1/mcp" });
    const internals = client as unknown as {
      _authProvider: { refreshFailedTransiently: boolean };
      _isAuthFailure(err: unknown): boolean;
    };
    internals._authProvider = { refreshFailedTransiently: true };

    expect(internals._isAuthFailure(new IssuerMismatchError("metadata", "https://a.example", "https://b.example"))).toBe(true);
    expect(internals._isAuthFailure(new SdkOAuthError("slow_down", "rate limited"))).toBe(false);
  });
});
