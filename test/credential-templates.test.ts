import { describe, it, expect } from "vitest";
import { Server, InMemoryTransport } from "@modelcontextprotocol/server";
import {
  hasCredentialTemplates,
  isSendableHeaderValue,
  resolveCredentialTemplates,
} from "../src/credentials/resolve-templates.js";
import { CredentialStore } from "../src/credentials/credential-store.js";
import { CredentialError } from "../src/credentials/errors.js";
import type { Credential } from "../src/credentials/types.js";
import { HttpUpstreamClient } from "../src/upstream/http-client.js";
import { startCountingUpstream } from "./_helpers/counting-http-upstream.js";

// --- Mock credential store ---

/** In-memory credential store backed by a map, no disk I/O. */
class InMemoryCredentialStore {
  private _credentials = new Map<string, Credential>();

  set(key: string, credential: Credential): void {
    this._credentials.set(key, credential);
  }

  async get(key: string): Promise<Credential | undefined> {
    return this._credentials.get(key);
  }

  async list(): Promise<string[]> {
    return [...this._credentials.keys()];
  }
}

/** Wrap InMemoryCredentialStore to satisfy CredentialStore interface in resolveCredentialTemplates. */
function createMockStore(entries: Record<string, Credential>): CredentialStore {
  const store = new InMemoryCredentialStore();
  for (const [k, v] of Object.entries(entries)) {
    store.set(k, v);
  }
  // resolveCredentialTemplates only calls .get() so duck-typing is fine
  return store as unknown as CredentialStore;
}

// --- hasCredentialTemplates tests ---

describe("hasCredentialTemplates", () => {
  it("returns true when record contains a template", () => {
    expect(hasCredentialTemplates({ TOKEN: "${credential:my-key}" })).toBe(true);
  });

  it("returns true for mixed content", () => {
    expect(hasCredentialTemplates({ AUTH: "Bearer ${credential:tok}" })).toBe(true);
  });

  it("returns false for plain values", () => {
    expect(hasCredentialTemplates({ TOKEN: "ghp_abc123" })).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(hasCredentialTemplates(undefined)).toBe(false);
  });

  it("returns false for empty record", () => {
    expect(hasCredentialTemplates({})).toBe(false);
  });
});

// --- resolveCredentialTemplates tests ---

describe("resolveCredentialTemplates", () => {
  it("replaces ${credential:key} with value (secret type)", async () => {
    const store = createMockStore({
      "github-pat": { type: "secret", value: "ghp_abc123" },
    });
    const result = await resolveCredentialTemplates(
      { GITHUB_TOKEN: "${credential:github-pat}" },
      store,
    );
    expect(result).toEqual({ GITHUB_TOKEN: "ghp_abc123" });
  });

  it("replaces ${credential:key} with access_token (bearer type)", async () => {
    const store = createMockStore({
      "api-key": { type: "bearer", access_token: "tok_bearer" },
    });
    const result = await resolveCredentialTemplates(
      { TOKEN: "${credential:api-key}" },
      store,
    );
    expect(result).toEqual({ TOKEN: "tok_bearer" });
  });

  it("replaces ${credential:key} with access_token (oauth2 type)", async () => {
    const store = createMockStore({
      "google": { type: "oauth2", access_token: "ya29.xyz" },
    });
    const result = await resolveCredentialTemplates(
      { AUTH: "${credential:google}" },
      store,
    );
    expect(result).toEqual({ AUTH: "ya29.xyz" });
  });

  it("handles mixed content: 'Bearer ${credential:key}'", async () => {
    const store = createMockStore({
      "tok": { type: "secret", value: "abc123" },
    });
    const result = await resolveCredentialTemplates(
      { Authorization: "Bearer ${credential:tok}" },
      store,
    );
    expect(result).toEqual({ Authorization: "Bearer abc123" });
  });

  it("handles multiple templates in one value", async () => {
    const store = createMockStore({
      user: { type: "secret", value: "admin" },
      pass: { type: "secret", value: "s3cret" },
    });
    const result = await resolveCredentialTemplates(
      { DSN: "${credential:user}:${credential:pass}@host" },
      store,
    );
    expect(result).toEqual({ DSN: "admin:s3cret@host" });
  });

  it("handles credential values containing $ characters", async () => {
    const store = createMockStore({
      pass: { type: "secret", value: "pa$$w0rd$&more" },
    });
    const result = await resolveCredentialTemplates(
      { DB_PASS: "${credential:pass}" },
      store,
    );
    expect(result).toEqual({ DB_PASS: "pa$$w0rd$&more" });
  });

  it("handles the same template key repeated in one value", async () => {
    const store = createMockStore({
      user: { type: "secret", value: "admin" },
    });
    const result = await resolveCredentialTemplates(
      { DSN: "${credential:user}:${credential:user}@host" },
      store,
    );
    expect(result).toEqual({ DSN: "admin:admin@host" });
  });

  it("passes through values without templates", async () => {
    const store = createMockStore({});
    const result = await resolveCredentialTemplates(
      { HOST: "example.com", PORT: "443" },
      store,
    );
    expect(result).toEqual({ HOST: "example.com", PORT: "443" });
  });

  it("throws when credential key not found", async () => {
    const store = createMockStore({});
    await expect(
      resolveCredentialTemplates(
        { TOKEN: "${credential:missing}" },
        store,
      ),
    ).rejects.toThrow(CredentialError);
    await expect(
      resolveCredentialTemplates(
        { TOKEN: "${credential:missing}" },
        store,
      ),
    ).rejects.toThrow(/not found/);
  });

  it("empty record returns empty record", async () => {
    const store = createMockStore({});
    const result = await resolveCredentialTemplates({}, store);
    expect(result).toEqual({});
  });
});

describe("isSendableHeaderValue", () => {
  it.each(["Bearer token", "token\r\n", "\t token ", "caf\u00e9", "a\tb"])("accepts %j, as fetch sends it", (value) => {
    expect(isSendableHeaderValue(value)).toBe(true);
  });

  it.each(["a\nb", "a\rb", "a\u0000b", "a\u0001b", "a\u007fb", "\u20ac"])("refuses %j", (value) => {
    expect(isSendableHeaderValue(value)).toBe(false);
  });

  it("checks a value with a long run of spaces inside it at once", () => {
    const started = performance.now();

    expect(isSendableHeaderValue(`a${" ".repeat(1_000_000)}b`)).toBe(true);

    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

// --- Integration tests (mock transport + credential store) ---

function createMockServer() {
  const server = new Server(
    { name: "mock-upstream", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", () => ({ tools: [] }));
  server.setRequestHandler("tools/call", (req) => ({
    content: [{ type: "text" as const, text: `Called ${req.params.name}` }],
  }));
  return server;
}

describe("integration: HTTP client with credential templates", () => {
  it("throws on missing credential during connect", async () => {
    const store = createMockStore({}); // empty store
    const mockServer = createMockServer();

    const client = new HttpUpstreamClient({
      name: "test-http",
      config: {
        type: "streamable-http",
        url: "http://localhost:9999",
        headers: { Authorization: "Bearer ${credential:missing-key}" },
      },
      credentialStore: store,
      _transportFactory: () => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        mockServer.connect(serverSide);
        return clientSide;
      },
    });

    await expect(client.connect()).rejects.toThrow(CredentialError);
    await client.close();
  });

  async function connectFailure(headers: Record<string, string>, value: string): Promise<string | undefined> {
    const client = new HttpUpstreamClient({
      name: "test-http",
      config: { type: "streamable-http", url: "http://127.0.0.1:9/mcp", headers },
      credentialStore: createMockStore({ token: { type: "secret", value } }),
    });
    try {
      await client.connect();
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      await client.close();
    }
  }

  it.each([
    ["a credential with a line break inside it", { Authorization: "Bearer ${credential:token}" }, "secret-value\r\nX-Injected: 1"],
    ["a credential with a character a header can't carry", { Authorization: "Bearer ${credential:token}" }, "secret-\u20ac"],
    ["a literal value with a line break inside it", { "x-api-key": "literal-secret\nx" }, "unused"],
    ["a credential with a NUL", { Authorization: "Bearer ${credential:token}" }, "secret\u0000x"],
  ])("refuses a header value with %s, without the value in the error", async (_label, headers, value) => {
    const [header] = Object.keys(headers);
    expect(await connectFailure(headers, value)).toBe(`the value of header "${header}" contains a line break, a NUL or a character a header can't carry`);
  });

  it.each([
    ["a credential ending in a line break, which fetch trims", "secret-value\n"],
    ["a credential ending in CRLF, which fetch trims", "secret-value\r\n"],
  ])("sends %s", async (_label, value) => {
    const server = await startCountingUpstream();
    const client = new HttpUpstreamClient({
      name: "test-http",
      config: { type: "streamable-http", url: server.url, headers: { Authorization: "Bearer ${credential:token}" } },
      credentialStore: createMockStore({ token: { type: "secret", value } }),
    });
    try {
      await client.connect();
      expect(server.authorizations()).toContain("Bearer secret-value");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    ["an unsendable header the transport sets itself", { type: "streamable-http" as const, url: "http://127.0.0.1:9/mcp", headers: { "mcp-session-id": "bad\nvalue" } }],
    [
      "an unsendable Authorization header that OAuth replaces",
      { type: "streamable-http" as const, url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer bad\nvalue" }, _bridge: { auth: { type: "oauth2" as const, clientId: "c" } } },
    ],
  ])("doesn't refuse %s, which is never sent", async (_label, config) => {
    const client = new HttpUpstreamClient({ name: "test-http", config, credentialStore: createMockStore({}) });
    const failure = await client.connect().then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    await client.close();

    expect(failure).not.toContain("can't carry");
  });

  it("connects normally without templates", async () => {
    const mockServer = createMockServer();

    const client = new HttpUpstreamClient({
      name: "test-http",
      config: {
        type: "streamable-http",
        url: "http://localhost:9999",
        headers: { Authorization: "Bearer static-token" },
      },
      credentialStore: createMockStore({}),
      _transportFactory: () => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        mockServer.connect(serverSide);
        return clientSide;
      },
    });

    await client.connect();
    expect(client.status).toBe("connected");
    await client.close();
  });

  it("connects normally without credential store", async () => {
    const mockServer = createMockServer();

    const client = new HttpUpstreamClient({
      name: "test-http",
      config: {
        type: "streamable-http",
        url: "http://localhost:9999",
      },
      _transportFactory: () => {
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        mockServer.connect(serverSide);
        return clientSide;
      },
    });

    await client.connect();
    expect(client.status).toBe("connected");
    await client.close();
  });
});

// STDIO credential expansion is now performed by `UpstreamManager` before
// instantiating `DaemonStdioClient`, so its coverage lives in the manager
// tests in `test/upstream.test.ts` (UpstreamManager describe block).
