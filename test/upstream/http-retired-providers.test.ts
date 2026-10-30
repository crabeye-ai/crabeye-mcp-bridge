import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientInfoKey, oauthCredentialKey } from "../../src/oauth/client-secret.js";
import { SharedRefreshes } from "../../src/oauth/shared-refreshes.js";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { startCountingUpstream, type CountingUpstream } from "../_helpers/counting-http-upstream.js";
import { makeTestStore, type TestStoreHandle } from "../_helpers/credential-store.js";
import { spyLogger, type SpyLogger } from "../_helpers/spy-logger.js";

const DROPPED = 'dropped the tokens of a refresh for "svc" after the stored tokens changed';

describe("the OAuth providers an HTTP upstream client leaves behind", () => {
  let storeHandle: TestStoreHandle;
  let server: CountingUpstream;
  let logger: SpyLogger;
  let refreshes: SharedRefreshes;
  let client: HttpUpstreamClient;

  beforeEach(async () => {
    storeHandle = makeTestStore("crabeye-retired-providers-");
    server = await startCountingUpstream({ oauth: true });
    await storeHandle.store.set(oauthCredentialKey("svc"), { type: "oauth2", access_token: "at-0", refresh_token: "rt-0", token_type: "Bearer", issuer: server.issuer });
    logger = spyLogger();
    refreshes = new SharedRefreshes();
    client = new HttpUpstreamClient({
      name: "svc",
      config: { type: "streamable-http", url: server.url, _bridge: { auth: { type: "oauth2", clientId: "ci" } } },
      credentialStore: storeHandle.store,
      logger,
      refreshes,
    });
    await client.connect();
  });

  afterEach(async () => {
    server.holdRefreshResponses(false);
    await client.close().catch(() => {});
    await server.close();
    storeHandle.cleanup();
  });

  async function holdRefreshOfCall(): Promise<void> {
    server.holdRefreshResponses(true);
    server.expireAccessTokens();
    void client.callTool({ name: "echo" }).catch(() => {});
    await vi.waitFor(() => expect(server.heldRefreshResponses()).toBe(1));
  }

  const removeCredentials = () => storeHandle.store.deleteMany([oauthCredentialKey("svc"), clientInfoKey("svc")]);
  const drops = () => logger.info.mock.calls.filter(([message]) => message === DROPPED).length;

  it("doesn't let the providers of the connection it replaced and of the new one restore credentials removed meanwhile", async () => {
    const joining = vi.spyOn(refreshes, "fetch");
    await holdRefreshOfCall();
    void client.reconnect().catch(() => {});
    await vi.waitFor(() => expect(joining).toHaveBeenCalledTimes(2));
    await removeCredentials();
    client.retireAuth();

    server.holdRefreshResponses(false);

    await vi.waitFor(() => expect(drops()).toBe(2), { timeout: 5_000 });
    expect(await storeHandle.store.get(oauthCredentialKey("svc"))).toBeUndefined();
  });

  it("doesn't let the provider of a closed client restore credentials removed after it closed, once told they changed", async () => {
    await holdRefreshOfCall();
    await client.close();
    await removeCredentials();
    client.retireAuth();

    server.holdRefreshResponses(false);

    await vi.waitFor(() => expect(drops()).toBe(1), { timeout: 5_000 });
    expect(await storeHandle.store.get(oauthCredentialKey("svc"))).toBeUndefined();
  });

  it("still restores a closed client's refresh where another process deleted the tokens it refreshed", async () => {
    await holdRefreshOfCall();
    await client.close();
    await storeHandle.store.delete(oauthCredentialKey("svc"));

    server.holdRefreshResponses(false);

    await vi.waitFor(async () => expect(await storeHandle.store.get(oauthCredentialKey("svc"))).toMatchObject({ refresh_token: "rt-1" }), { timeout: 5_000 });
  });

  it("still saves a closed client's refresh over the tokens it refreshed, which the server won't accept again", async () => {
    await holdRefreshOfCall();
    await client.close();

    server.holdRefreshResponses(false);

    await vi.waitFor(async () => expect(await storeHandle.store.get(oauthCredentialKey("svc"))).toMatchObject({ refresh_token: "rt-1" }), { timeout: 5_000 });
  });

  it("still restores the refresh of a connection it replaced on its own where another process deleted the tokens it refreshed", async () => {
    server.holdRefreshResponses(true);
    server.refuseEveryAccessToken(true);
    void client.callTool({ name: "echo" }).catch(() => {});
    await vi.waitFor(() => expect(server.heldRefreshResponses()).toBe(1));
    server.refuseEveryAccessToken(false);
    await client.reconnect();
    await storeHandle.store.delete(oauthCredentialKey("svc"));

    server.holdRefreshResponses(false);

    await vi.waitFor(async () => expect(await storeHandle.store.get(oauthCredentialKey("svc"))).toMatchObject({ refresh_token: "rt-1" }), { timeout: 5_000 });
  });
});
