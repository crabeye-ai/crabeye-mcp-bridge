import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IssuerMismatchError } from "@modelcontextprotocol/client";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import { BridgeConfigSchema, type BridgeConfig } from "../../src/config/schema.js";
import { runAuthLogin } from "../../src/commands/auth.js";
import { clientInfoKey, oauthCredentialKey } from "../../src/oauth/index.js";
import { parseStoredClientInfo } from "../../src/oauth/issuer-binding.js";
import { makeTestStore } from "../_helpers/credential-store.js";
import { startProtectedUpstream, type ProtectedUpstream } from "../_helpers/protected-upstream.js";

const SERVER = "fake";
type ErrorLineFor = (expectedIssuer: string) => string;

const MISMATCH: ErrorLineFor = (expectedIssuer) =>
  `Error: Authorization response came from a different issuer than expected (${expectedIssuer}) — possible authorization-server mix-up; aborting.`;
const MISSING: ErrorLineFor = (expectedIssuer) =>
  `Error: Authorization response did not include the issuer identifier that ${expectedIssuer} requires — possible authorization-server mix-up; aborting.`;
const METADATA_MISMATCH: ErrorLineFor = (expectedIssuer) =>
  `Error: Authorization server metadata issuer does not match ${expectedIssuer} — aborting.`;

type IssFor = (issuer: string) => string | undefined;

const matching: IssFor = (issuer) => issuer;
const absent: IssFor = () => undefined;
const empty: IssFor = () => "";
const foreign: IssFor = () => "https://evil.example/PAYLOAD";
const trailingSlash: IssFor = (issuer) => `${issuer}/`;

interface LoginOptions {
  advertised?: boolean;
  iss?: IssFor;
  metadataIssuer?: string;
  omitMetadata?: boolean;
}

interface LoginResult {
  code: number;
  stderr: string;
  upstream: ProtectedUpstream;
}

function makeConfig(url: string): BridgeConfig {
  return BridgeConfigSchema.parse({
    mcpServers: {
      [SERVER]: { type: "streamable-http", url, _bridge: { auth: { type: "oauth2" } } },
    },
  });
}

function errorLine(stderr: string): string | undefined {
  return stderr.split("\n").find((line) => line.startsWith("Error:"));
}

function callbackFor(authorizationUrl: string, iss: string | undefined): URL {
  const authorization = new URL(authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", "auth-code");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  if (iss !== undefined) callback.searchParams.set("iss", iss);
  return callback;
}

describe("crabeye auth against a real authorization server", () => {
  let store: CredentialStore;
  let cleanup: () => void;
  let started: ProtectedUpstream | undefined;

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("auth-flow-"));
  });

  afterEach(async () => {
    await started?.close();
    started = undefined;
    cleanup();
  });

  async function login({ advertised = false, iss = matching, metadataIssuer, omitMetadata }: LoginOptions = {}): Promise<LoginResult> {
    const upstream = await startProtectedUpstream("ok", { issParameterSupported: advertised, metadataIssuer, omitMetadata });
    started = upstream;
    const stderr: string[] = [];
    const code = await runAuthLogin(
      { serverName: SERVER },
      {
        store,
        print: () => {},
        errPrint: (line) => stderr.push(line),
        loadConfig: async () => makeConfig(upstream.url),
        openBrowser: async (authorizationUrl) => {
          await fetch(callbackFor(authorizationUrl, iss(upstream.issuer)));
          return true;
        },
      },
    );
    return { code, stderr: stderr.join("\n"), upstream };
  }

  async function expectAuthorized({ code, stderr, upstream }: LoginResult): Promise<void> {
    expect(code).toBe(0);
    expect(stderr).not.toMatch(/Error:/);
    expect(upstream.tokenRequests()).toBe(1);
    expect(await store.get(oauthCredentialKey(SERVER))).toMatchObject({ type: "oauth2", access_token: "valid" });
  }

  async function expectRefusedBeforeRedeem({ code, stderr, upstream }: LoginResult, message: ErrorLineFor): Promise<void> {
    expect(code).toBe(1);
    expect(errorLine(stderr)).toBe(message(upstream.issuer));
    expect(stderr).not.toContain("PAYLOAD");
    expect(upstream.tokenRequests()).toBe(0);
    expect(await store.get(oauthCredentialKey(SERVER))).toBeUndefined();
    expect(parseStoredClientInfo(await store.get(clientInfoKey(SERVER)))).toMatchObject({
      client_id: "client-1",
      issuer: upstream.issuer,
    });
  }

  it("authorizes again over a stored access token that can't be sent in a header", async () => {
    await store.set(oauthCredentialKey(SERVER), { type: "oauth2", access_token: "stale\nX-Injected: 1", refresh_token: "rt-stale" });

    await expectAuthorized(await login());
  });

  describe("authorization-response issuer (RFC 9207)", () => {
    const ACCEPTED: [string, boolean, IssFor][] = [
      ["matching iss, support not advertised", false, matching],
      ["matching iss, support advertised", true, matching],
      ["missing iss, support not advertised", false, absent],
      ["empty iss, support not advertised", false, empty],
    ];

    it.each(ACCEPTED)("accepts %s", async (_name, advertised, iss) => {
      await expectAuthorized(await login({ advertised, iss }));
    });

    const REFUSED: [string, boolean, IssFor, ErrorLineFor][] = [
      ["missing iss, support advertised", true, absent, MISSING],
      ["empty iss, support advertised", true, empty, MISSING],
      ["foreign iss, support not advertised", false, foreign, MISMATCH],
      ["foreign iss, support advertised", true, foreign, MISMATCH],
      ["iss with an extra trailing slash", true, trailingSlash, MISMATCH],
    ];

    it.each(REFUSED)("refuses %s before redeeming the code", async (_name, advertised, iss, message) => {
      await expectRefusedBeforeRedeem(await login({ advertised, iss }), message);
    });
  });

  describe("authorization-response issuer without authorization server metadata", () => {
    const ACCEPTED: [string, IssFor][] = [
      ["matching iss", matching],
      ["matching iss with a trailing slash", trailingSlash],
      ["missing iss", absent],
      ["empty iss", empty],
    ];

    it.each(ACCEPTED)("accepts %s", async (_name, iss) => {
      await expectAuthorized(await login({ omitMetadata: true, iss }));
    });

    it("refuses an iss naming a different server before redeeming the code", async () => {
      await expectRefusedBeforeRedeem(await login({ omitMetadata: true, iss: foreign }), MISMATCH);
    });
  });

  describe("authorization server metadata", () => {
    it("refuses metadata that names a different issuer before registering", async () => {
      const { code, stderr, upstream } = await login({ metadataIssuer: "https://other.example" });

      expect(code).toBe(1);
      expect(errorLine(stderr)).toBe(METADATA_MISMATCH(upstream.issuer));
      expect(upstream.registrations()).toHaveLength(0);
      expect(upstream.tokenRequests()).toBe(0);
    });
  });

  describe("dynamic client registration", () => {
    it("registers as a native application with the loopback redirect URI", async () => {
      const { code, upstream } = await login();

      expect(code).toBe(0);
      const registrations = upstream.registrations();
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toMatchObject({ application_type: "native" });
      expect(registrations[0].redirect_uris).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)]);
    });
  });
});

describe("crabeye auth issuer error messages", () => {
  const HOSTILE_ISSUER = "https://as.example\x1b]0;pwned\x07";
  let store: CredentialStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("auth-messages-"));
  });

  afterEach(() => {
    cleanup();
  });

  const CASES: [string, IssuerMismatchError, ErrorLineFor][] = [
    ["a mismatched iss", new IssuerMismatchError("authorization_response", HOSTILE_ISSUER, "https://evil.example"), MISMATCH],
    ["a missing iss", new IssuerMismatchError("authorization_response", HOSTILE_ISSUER, undefined), MISSING],
    ["mismatched metadata", new IssuerMismatchError("metadata", HOSTILE_ISSUER, "https://other.example"), METADATA_MISMATCH],
  ];

  it.each(CASES)("escapes control characters in the expected issuer for %s", async (_name, error, message) => {
    const stderr: string[] = [];
    const code = await runAuthLogin(
      { serverName: SERVER },
      {
        store,
        print: () => {},
        errPrint: (line) => stderr.push(line),
        loadConfig: async () => makeConfig("https://fake.example/mcp"),
        auth: (async () => {
          throw error;
        }) as never,
      },
    );

    expect(code).toBe(1);
    const text = stderr.join("\n");
    expect(errorLine(text)).toBe(message("https://as.example\\x1b]0;pwned\\x07"));
    expect(text).not.toMatch(/[\x00-\x09\x0b-\x1f]/);
  });
});
