import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { IssuerMismatchError, OAuthError as SdkOAuthError } from "@modelcontextprotocol/client";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { clientInfoKey, oauthCredentialKey } from "../../src/oauth/client-secret.js";
import type { HttpServerConfig } from "../../src/config/schema.js";
import type { ConnectionStatus } from "../../src/upstream/types.js";
import { makeTestStore, type TestStoreHandle } from "../_helpers/credential-store.js";

type TokenEndpoint = "invalid_grant" | "unavailable" | "rate_limited_json" | "unavailable_json";
type ResourceGuard = "token" | "insufficient_scope";

interface ProtectedUpstream {
  url: string;
  mcpRequests: () => number;
  expireAccessToken: (refreshOutcome: TokenEndpoint) => void;
  close: () => Promise<void>;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function startProtectedUpstream(tokenEndpoint: TokenEndpoint, guard: ResourceGuard = "token"): Promise<ProtectedUpstream> {
  let mcpRequests = 0;
  let acceptedToken: string | undefined = "valid";
  const server = http.createServer(async (req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url!, base);
    const body = await readBody(req);
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/token") {
      if (tokenEndpoint === "unavailable") {
        res.writeHead(503);
        return res.end();
      }
      if (tokenEndpoint === "rate_limited_json") return json(429, { error: "slow_down" });
      if (tokenEndpoint === "unavailable_json") return json(503, { error: "Service Unavailable" });
      return json(400, { error: "invalid_grant" });
    }
    if (url.pathname === "/mcp") {
      mcpRequests++;
      if (guard === "insufficient_scope") {
        res.writeHead(403, { "www-authenticate": `Bearer error="insufficient_scope", scope="admin"` });
        return res.end();
      }
      if (acceptedToken === undefined || req.headers.authorization !== `Bearer ${acceptedToken}`) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      const mcp = new Server({ name: "protected", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler("tools/list", () => ({ tools: [] }));
      await mcp.connect(transport);
      const response = await transport.handleRequest(
        new Request(url, {
          method: req.method,
          headers: Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === "string"),
          body: req.method === "GET" ? undefined : new Uint8Array(body),
        }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      return res.end(Buffer.from(await response.arrayBuffer()));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    mcpRequests: () => mcpRequests,
    expireAccessToken: (refreshOutcome) => {
      acceptedToken = undefined;
      tokenEndpoint = refreshOutcome;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

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
