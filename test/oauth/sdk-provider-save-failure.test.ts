import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@modelcontextprotocol/client";
import { clientIssuerKey, oauthCredentialKey } from "../../src/oauth/index.js";
import { BridgeOAuthClientProvider } from "../../src/oauth/sdk-provider.js";
import { makeTestStore, type TestStoreHandle } from "../_helpers/credential-store.js";
import { startLoginWorld, type LoginWorld } from "../_helpers/login-auth-servers.js";
import { spyLogger, type SpyLogger } from "../_helpers/spy-logger.js";

const SERVER = "srv";
const KEY = oauthCredentialKey(SERVER);
const CLIENT_ID = "client-1";
const FAILED = 'could not save the tokens for "srv": Credential store setIf exceeded 60000ms waiting for the lock';

describe("BridgeOAuthClientProvider when refreshed tokens can't be saved", { timeout: 20_000 }, () => {
  let handle: TestStoreHandle;
  let world: LoginWorld;
  let logger: SpyLogger;

  beforeEach(async () => {
    handle = makeTestStore("sdk-provider-save-failure-");
    world = await startLoginWorld();
    world.a.refresh = "rotate";
    logger = spyLogger();
    await handle.store.set(clientIssuerKey(SERVER), { type: "secret", value: JSON.stringify({ client_id: CLIENT_ID, issuer: world.a.issuer }) });
    await handle.store.set(KEY, { type: "oauth2", access_token: "at-0", token_type: "Bearer", refresh_token: "rt-a", issuer: world.a.issuer, expires_at: 1 });
    vi.spyOn(handle.store, "setIf").mockRejectedValue(new Error("Credential store setIf exceeded 60000ms waiting for the lock"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await world.close();
    handle.cleanup();
  });

  it.each([
    ["the manager", true],
    ["the auth command", false],
  ])("fails %s's refresh with an error naming the server and the cause, logs it, and leaves the stored tokens alone", async (_case, runtime) => {
    const bridge = new BridgeOAuthClientProvider({
      serverName: SERVER,
      store: handle.store,
      redirectUrl: "http://127.0.0.1/callback",
      clientId: CLIENT_ID,
      logger,
      ...(runtime ? { runtime: true } : { onRedirect: async () => {} }),
    });

    await expect(auth(bridge, { serverUrl: world.resourceUrl, fetchFn: bridge.wrapFetch(fetch) })).rejects.toThrow(FAILED);

    expect(logger.warn).toHaveBeenCalledWith(FAILED, { component: "oauth" });
    expect(await handle.store.get(KEY)).toMatchObject({ access_token: "at-0", refresh_token: "rt-a" });
  });
});
