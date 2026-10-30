import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import { runAuthLogin, runAuthRemove, type AuthCommandDeps } from "../../src/commands/auth.js";
import { BridgeConfigSchema, type BridgeConfig } from "../../src/config/schema.js";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import { oauthCredentialKey } from "../../src/oauth/index.js";
import { makeTestStore } from "../_helpers/credential-store.js";

function makeConfig(): BridgeConfig {
  return BridgeConfigSchema.parse({
    mcpServers: { notion: { url: "https://notion.example.com/mcp", _bridge: { auth: { type: "oauth2", clientId: "client-1" } } } },
  });
}

type TellManager = NonNullable<AuthCommandDeps["tellManagerAuthChanged"]>;

describe("auth telling a running manager that the credentials changed", () => {
  let store: CredentialStore;
  let cleanup: () => void;
  let events: string[];
  let signals: Array<AbortSignal | undefined>;

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("auth-notify-"));
    events = [];
    signals = [];
  });

  afterEach(() => {
    cleanup();
  });

  const recording: TellManager = async (server, { signal }) => {
    events.push(`tell ${server}`);
    signals.push(signal);
  };

  const deps = (tellManager: TellManager = recording) => ({
    store,
    print: (line: string) => events.push(`print ${line}`),
    errPrint: (line: string) => events.push(`error ${line}`),
    loadConfig: async () => makeConfig(),
    tellManagerAuthChanged: tellManager,
  });

  const callbackServer = (result: Promise<{ code: string; state: string }>) => async () => ({
    port: 12345,
    redirectUri: "http://127.0.0.1:12345/callback",
    result,
    close: async () => void events.push("close listener"),
  });

  async function login(serverName: string, { tellManager, signal, failure }: { tellManager?: TellManager; signal?: AbortSignal; failure?: "state" | "exchange" } = {}): Promise<number> {
    let resolveCallback!: (callback: { code: string; state: string }) => void;
    const callback = new Promise<{ code: string; state: string }>((resolve) => (resolveCallback = resolve));
    let state = "";
    const auth = async (provider: OAuthClientProvider, options: { authorizationCode?: string }) => {
      if (options.authorizationCode === undefined) {
        state = (await provider.state?.()) ?? "";
        await provider.redirectToAuthorization(new URL(`https://provider.example.com/authorize?state=${state}`));
        return "REDIRECT";
      }
      if (failure === "exchange") return "REDIRECT";
      await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
      return "AUTHORIZED";
    };
    return runAuthLogin(
      { serverName },
      {
        ...deps(tellManager),
        signal,
        startCallbackServer: callbackServer(callback),
        openBrowser: async () => {
          resolveCallback({ code: "code", state: failure === "state" ? "forged" : state });
          return true;
        },
        auth: auth as never,
      },
    );
  }

  const shown = () => events.filter((event) => !event.startsWith("error "));

  it("tells it after removing the credentials, by the name in config, once the output is printed", async () => {
    await store.set(oauthCredentialKey("notion"), { type: "oauth2", access_token: "n" });

    expect(await runAuthRemove("NOTION", {}, deps())).toBe(0);

    expect(events).toEqual(['print Removed local token for "notion"', "tell notion"]);
  });

  it("doesn't tell it when there was nothing to remove", async () => {
    expect(await runAuthRemove("notion", {}, deps())).toBe(1);
    expect(events).toEqual(['error No stored credentials for "notion"']);
  });

  it("tells it after authenticating, by the name in config, once the loopback listener is closed, passing on its abort signal", async () => {
    const controller = new AbortController();

    expect(await login("NOTION", { tellManager: recording, signal: controller.signal })).toBe(0);

    expect(shown()).toEqual(['print Authenticated "notion"', "close listener", "tell notion"]);
    expect(signals).toEqual([controller.signal]);
  });

  it("tells it when the server was already authenticated, since the tokens may just have been refreshed", async () => {
    const code = await runAuthLogin(
      { serverName: "notion" },
      { ...deps(), startCallbackServer: callbackServer(new Promise(() => {})), auth: (async () => "AUTHORIZED") as never },
    );

    expect(code).toBe(0);
    expect(events).toEqual(['print Already authenticated as "notion"', "close listener", "tell notion"]);
  });

  it("doesn't tell it when authenticating fails", async () => {
    expect(await runAuthLogin({ serverName: "unknown" }, deps())).toBe(1);
    expect(events.some((event) => event.startsWith("tell"))).toBe(false);
  });

  it.each([
    ["the authorization server refuses the code", { auth: (async () => Promise.reject(new Error("invalid_grant"))) as never }],
    ["the loopback listener can't start", { startCallbackServer: async () => Promise.reject(new Error("listen EADDRINUSE")) }],
  ])("doesn't tell it when authorizing throws because %s", async (_label, failing) => {
    expect(await runAuthLogin({ serverName: "notion" }, { ...deps(), startCallbackServer: callbackServer(new Promise(() => {})), ...failing })).toBe(1);
    expect(events.some((event) => event.startsWith("tell"))).toBe(false);
  });

  it.each([
    ["a callback whose state doesn't match", "state"],
    ["a code exchange that doesn't complete", "exchange"],
  ] as const)("doesn't tell it when authorizing ends with %s", async (_label, failure) => {
    expect(await login("notion", { failure })).toBe(1);
    expect(events.some((event) => event.startsWith("tell"))).toBe(false);
  });

  it.each([
    ["rejects", (async () => Promise.reject(new Error("manager exploded"))) as TellManager],
    ["throws before returning a promise", (() => {
      throw new Error("manager exploded");
    }) as TellManager],
  ])("keeps its output and exit code when telling the manager %s", async (_label, failing) => {
    await store.set(oauthCredentialKey("notion"), { type: "oauth2", access_token: "n" });

    expect(await runAuthRemove("notion", {}, deps(failing))).toBe(0);
    expect(await login("notion", { tellManager: failing })).toBe(0);

    expect(shown()).toEqual(['print Removed local token for "notion"', 'print Authenticated "notion"', "close listener"]);
  });
});
