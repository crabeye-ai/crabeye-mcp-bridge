import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialStore } from "../../src/credentials/credential-store.js";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { oauthCredentialKey } from "../../src/oauth/client-secret.js";
import { makeTestStore, type TestStoreHandle } from "../_helpers/credential-store.js";
import { startProtectedUpstream, type ProtectedUpstream } from "../_helpers/protected-upstream.js";

describe("HTTP upstream master key reads", () => {
  let storeHandle: TestStoreHandle;
  let upstream: ProtectedUpstream | undefined;
  let client: HttpUpstreamClient | undefined;

  beforeEach(() => {
    storeHandle = makeTestStore("crabeye-key-reads-");
  });

  afterEach(async () => {
    await client?.close();
    await upstream?.close();
    client = undefined;
    upstream = undefined;
    storeHandle.cleanup();
  });

  it("reads the keychain once across connects, pings and tool calls of an OAuth upstream", async () => {
    upstream = await startProtectedUpstream("invalid_grant");
    await storeHandle.store.set(oauthCredentialKey("protected"), { type: "oauth2", access_token: "valid" });
    const { keychain } = storeHandle;
    const store = new CredentialStore({ keychain, filePath: storeHandle.filePath });
    keychain.reads = 0;
    client = new HttpUpstreamClient({
      name: "protected",
      config: { type: "streamable-http", url: upstream.url, _bridge: { auth: { type: "oauth2", clientId: "ci" } } },
      credentialStore: store,
      reconnectBaseDelay: 100,
      reconnectMaxDelay: 1_000,
    });

    await client.connect();
    await client.ping();
    await client.callTool({ name: "anything" }).catch(() => {});
    await client.reconnect();
    await client.ping();
    await client.reconnect();
    await client.ping();

    expect(client.status).toBe("connected");
    expect(upstream.mcpRequests()).toBeGreaterThan(6);
    expect(keychain.reads).toBe(1);
  });
});
