import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { oauthCredentialKey } from "../../src/oauth/client-secret.js";
import { CredentialError } from "../../src/credentials/errors.js";
import { makeTestStore, type TestStoreHandle } from "../_helpers/credential-store.js";
import { startProtectedUpstream, type ProtectedUpstream } from "../_helpers/protected-upstream.js";
import { spyLogger, type SpyLogger } from "../_helpers/spy-logger.js";

const KEY = oauthCredentialKey("protected");

describe("HTTP upstream refresh rejected while another process holds newer tokens (#224)", () => {
  let storeHandle: TestStoreHandle;
  let upstream: ProtectedUpstream;
  let client: HttpUpstreamClient | undefined;
  let logger: SpyLogger;

  beforeEach(async () => {
    logger = spyLogger();
    storeHandle = makeTestStore("crabeye-rejected-refresh-");
    upstream = await startProtectedUpstream("invalid_grant");
    await storeHandle.store.set(KEY, {
      type: "oauth2",
      access_token: "expired",
      refresh_token: "refresh-me",
      expires_at: Math.floor(Date.now() / 1000) - 60,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await client?.close();
    await upstream.close();
    client = undefined;
    storeHandle.cleanup();
  });

  function connectClient(): Promise<void> {
    client = new HttpUpstreamClient({
      name: "protected",
      config: { type: "streamable-http", url: upstream.url, _bridge: { auth: { type: "oauth2", clientId: "ci" } } },
      credentialStore: storeHandle.store,
      logger,
      reconnectBaseDelay: 100,
      reconnectMaxDelay: 1_000,
    });
    return client.connect().catch(() => {});
  }

  it("checks what is stored before stamping or deleting the tokens the authorization server rejected", async () => {
    const replaceIf = vi.spyOn(storeHandle.store, "replaceIf");
    const deleteIf = vi.spyOn(storeHandle.store, "deleteIf");
    const deleteUnconditionally = vi.spyOn(storeHandle.store, "delete");

    await connectClient();

    expect(replaceIf).toHaveBeenCalledWith(KEY, expect.objectContaining({ issuer: expect.any(String) }), expect.any(Function));
    expect(deleteIf).toHaveBeenCalledWith(KEY, expect.any(Function));
    expect(deleteUnconditionally).not.toHaveBeenCalledWith(KEY);
    expect(await storeHandle.store.get(KEY)).toBeUndefined();
  });

  it("keeps the tokens and doesn't ask for auth when the store's lock can't be taken", async () => {
    vi.spyOn(storeHandle.store, "deleteIf").mockRejectedValue(
      new CredentialError("Credential store deleteIf exceeded 300ms waiting for the lock"),
    );

    await connectClient();

    expect(client!.status).toBe("disconnected");
    expect(await storeHandle.store.get(KEY)).toMatchObject({ refresh_token: "refresh-me" });
    expect(logger.warn).toHaveBeenCalledWith(
      'could not check the stored tokens for "protected"; keeping them',
      expect.objectContaining({ component: "oauth" }),
    );
  });
});
