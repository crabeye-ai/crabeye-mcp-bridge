import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import { runAuthLogin } from "../../src/commands/auth.js";
import { BridgeConfigSchema } from "../../src/config/schema.js";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import { makeTestStore } from "../_helpers/credential-store.js";

const config = BridgeConfigSchema.parse({
  mcpServers: { notion: { url: "https://notion.example.com/mcp", _bridge: { auth: { type: "oauth2", clientId: "ci", clientSecret: "${NOTION_OAUTH_SECRET}" } } } },
});

describe("auth <server> with a client secret from the shell's environment", () => {
  let store: CredentialStore;
  let cleanup: () => void;
  let errors: string[];

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("auth-client-secret-"));
    errors = [];
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    cleanup();
  });

  function login(auth: (provider: OAuthClientProvider) => Promise<"AUTHORIZED">): Promise<number> {
    return runAuthLogin(
      { serverName: "notion" },
      {
        store,
        print: () => {},
        errPrint: (line) => errors.push(line),
        loadConfig: async () => config,
        startCallbackServer: async () => ({ port: 1, redirectUri: "http://127.0.0.1:1/callback", result: new Promise(() => {}), close: async () => {} }),
        auth: auth as never,
      },
    );
  }

  it("sends the secret the variable holds", async () => {
    vi.stubEnv("NOTION_OAUTH_SECRET", "from-the-shell");
    let secret: string | undefined;

    const code = await login(async (provider) => {
      secret = (await provider.clientInformation())?.client_secret;
      return "AUTHORIZED";
    });

    expect(code).toBe(0);
    expect(secret).toBe("from-the-shell");
  });

  it("names the variable when it isn't set", async () => {
    vi.stubEnv("NOTION_OAUTH_SECRET", "");

    expect(await login(async () => "AUTHORIZED")).toBe(1);

    expect(errors.join("\n")).toContain('Client secret env var "NOTION_OAUTH_SECRET" is not set');
  });
});
