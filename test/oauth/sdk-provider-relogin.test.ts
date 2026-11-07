import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth } from "@modelcontextprotocol/client";
import type { OAuth2Credential } from "../../src/credentials/types.js";
import { clientInfoKey, clientIssuerKey, oauthCredentialKey } from "../../src/oauth/index.js";
import { BridgeOAuthClientProvider } from "../../src/oauth/sdk-provider.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { makeTestStore, type TestStoreHandle } from "../_helpers/credential-store.js";
import { startLoginWorld, type LoginAuthServer, type LoginWorld } from "../_helpers/login-auth-servers.js";

const SERVER = "srv";
const KEY = oauthCredentialKey(SERVER);
const CLIENT_ID = "client-1";

describe("BridgeOAuthClientProvider keeping a refresh token across a new login", { timeout: 20_000 }, () => {
  let handle: TestStoreHandle;
  let world: LoginWorld;

  beforeEach(async () => {
    handle = makeTestStore("sdk-provider-relogin-");
    world = await startLoginWorld();
  });

  afterEach(async () => {
    await world.close();
    handle.cleanup();
  });

  function provider({ clientId, runtime = false }: { clientId?: string; runtime?: boolean } = {}): BridgeOAuthClientProvider {
    return new BridgeOAuthClientProvider({
      serverName: SERVER,
      store: handle.store,
      redirectUrl: "http://127.0.0.1/callback",
      ...(clientId !== undefined && { clientId }),
      ...(runtime ? { runtime: true } : { onRedirect: async () => {} }),
    });
  }

  const run = (bridge: BridgeOAuthClientProvider, authorizationCode?: string) =>
    auth(bridge, { serverUrl: world.resourceUrl, fetchFn: bridge.wrapFetch(fetch), ...(authorizationCode !== undefined && { authorizationCode }) });

  async function login(bridge: BridgeOAuthClientProvider): Promise<void> {
    expect(await run(bridge)).toBe("REDIRECT");
    expect(await run(bridge, "code-1")).toBe("AUTHORIZED");
  }

  async function seed(refreshToken: string, from: LoginAuthServer | undefined): Promise<void> {
    await handle.store.set(KEY, { type: "oauth2", access_token: "at-0", token_type: "Bearer", refresh_token: refreshToken, ...(from && { issuer: from.issuer }) });
  }

  async function seedRegistrationAtA(): Promise<void> {
    await handle.store.set(clientInfoKey(SERVER), { type: "secret", value: JSON.stringify({ client_id: "a-client", redirect_uris: ["http://127.0.0.1/callback"], issuer: world.a.issuer }) });
  }

  async function seedConfiguredClientAtA(): Promise<void> {
    await handle.store.set(clientIssuerKey(SERVER), { type: "secret", value: JSON.stringify({ client_id: CLIENT_ID, issuer: world.a.issuer }) });
  }

  async function readNewerTokensThatAreThenDeleted(reader: BridgeOAuthClientProvider): Promise<void> {
    await seed("rt-newer", world.a);
    await reader.tokens();
    await handle.store.delete(KEY);
  }

  async function stored(): Promise<OAuth2Credential | undefined> {
    const credential = await handle.store.get(KEY);
    return credential?.type === "oauth2" ? credential : undefined;
  }

  const sentRefreshTokens = (server: LoginAuthServer) => server.tokenRequests().flatMap((form) => (form.refresh_token === undefined ? [] : [form.refresh_token]));

  it("doesn't carry a refresh token from the old authorization server into a login at a new one", async () => {
    await seedRegistrationAtA();
    await seed("rt-a", world.a);
    world.useAuthorizationServer(world.b);

    await login(provider());
    const afterLogin = await stored();
    await run(provider());

    expect(afterLogin).toEqual(expect.objectContaining({ access_token: expect.stringMatching(/^b-login-/), issuer: world.b.issuer }));
    expect(afterLogin!.refresh_token).toBeUndefined();
    expect(sentRefreshTokens(world.b)).toEqual([]);
  });

  it("refuses a login at a new authorization server for a configured client, leaving the old tokens", async () => {
    await seedConfiguredClientAtA();
    await seed("rt-a", world.a);
    world.useAuthorizationServer(world.b);

    await expect(run(provider({ clientId: CLIENT_ID }))).rejects.toThrow(`Authorization server for "${SERVER}" is no longer ${world.a.issuer}`);

    expect(await stored()).toEqual({ type: "oauth2", access_token: "at-0", token_type: "Bearer", refresh_token: "rt-a", issuer: world.a.issuer });
    expect(world.b.tokenRequests()).toEqual([]);
  });

  it.each([
    ["stamped with the authorization server", true],
    ["with no authorization server recorded, which the login's first step stamps", false],
  ])("keeps the stored refresh token through a login at the same authorization server after a refresh failed, for tokens %s", async (_case, stamped) => {
    await seedRegistrationAtA();
    await seed("rt-a", stamped ? world.a : undefined);
    world.a.refresh = "fail";

    await login(provider());

    expect(await stored()).toEqual(expect.objectContaining({ access_token: expect.stringMatching(/^a-login-/), refresh_token: "rt-a", issuer: world.a.issuer }));
    world.a.refresh = "keep";
    expect(await run(provider())).toBe("AUTHORIZED");
    expect(sentRefreshTokens(world.a)).toEqual(["rt-a", "rt-a"]);
    expect(await stored()).toEqual(expect.objectContaining({ access_token: expect.stringMatching(/^a-refreshed-/), refresh_token: "rt-a" }));
  });

  it.each([
    ["the CLI", false],
    ["the manager", true],
  ])("keeps the redeemed refresh token after a refresh from a server that doesn't rotate it, in %s", async (_case, runtime) => {
    await seedConfiguredClientAtA();
    await seed("rt-a", world.a);

    expect(await run(provider({ clientId: CLIENT_ID, runtime }))).toBe("AUTHORIZED");

    expect(await stored()).toEqual(expect.objectContaining({ access_token: expect.stringMatching(/^a-refreshed-/), refresh_token: "rt-a" }));
  });

  it("saves a refresh with the refresh token it redeemed, not one read while it was in flight", async () => {
    await seedConfiguredClientAtA();
    await seed("rt-a", world.a);
    const manager = provider({ clientId: CLIENT_ID, runtime: true });
    world.a.holdRefreshes();
    const refreshing = run(manager);
    await until(() => world.a.heldRefreshes() === 1, 5_000);

    await readNewerTokensThatAreThenDeleted(manager);
    world.a.releaseRefreshes();

    expect(await refreshing).toBe("AUTHORIZED");
    expect((await stored())?.refresh_token).toBe("rt-a");
  });

  it("keeps a login that brings a new refresh token over a manager refresh of the old one that finishes after it", async () => {
    await seedConfiguredClientAtA();
    await seed("rt-a", world.a);
    const cli = provider({ clientId: CLIENT_ID });
    world.a.refresh = "fail";
    expect(await run(cli)).toBe("REDIRECT");
    world.a.refresh = "rotate";
    world.a.holdRefreshes();
    const refreshing = run(provider({ clientId: CLIENT_ID, runtime: true }));
    await until(() => world.a.heldRefreshes() === 1, 5_000);

    world.a.loginRefreshToken = "rt-login";
    expect(await run(cli, "code-1")).toBe("AUTHORIZED");
    world.a.releaseRefreshes();
    await refreshing;

    expect(await stored()).toEqual(expect.objectContaining({ access_token: expect.stringMatching(/^a-login-/), refresh_token: "rt-login" }));
  });
});
