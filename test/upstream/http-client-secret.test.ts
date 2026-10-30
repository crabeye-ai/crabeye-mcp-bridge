import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oauthCredentialKey } from "../../src/oauth/client-secret.js";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import { startCountingUpstream, type CountingUpstream } from "../_helpers/counting-http-upstream.js";
import { makeTestStore, type TestStoreHandle } from "../_helpers/credential-store.js";
import { spyLogger } from "../_helpers/spy-logger.js";

describe("the client secret of an HTTP upstream with _bridge.auth", () => {
  let storeHandle: TestStoreHandle;
  let server: CountingUpstream;
  let client: HttpUpstreamClient | undefined;

  beforeEach(async () => {
    storeHandle = makeTestStore("crabeye-client-secret-");
    server = await startCountingUpstream({ oauth: true });
    await storeHandle.store.set(oauthCredentialKey("svc"), {
      type: "oauth2",
      access_token: "at-0",
      refresh_token: "rt-0",
      token_type: "Bearer",
      issuer: server.issuer,
    });
    vi.stubEnv("NOTION_OAUTH_SECRET", "from-the-process");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await client?.close();
    client = undefined;
    await server.close();
    storeHandle.cleanup();
  });

  function connect(env?: Record<string, string>): Promise<void> {
    client = new HttpUpstreamClient({
      name: "svc",
      config: { type: "streamable-http", url: server.url, _bridge: { auth: { type: "oauth2", clientId: "ci", clientSecret: "${NOTION_OAUTH_SECRET}" } } },
      credentialStore: storeHandle.store,
      logger: spyLogger(),
      ...(env !== undefined && { env }),
    });
    return client.connect();
  }

  it("is read from the variables the client was given, not from the process environment", async () => {
    await connect({ NOTION_OAUTH_SECRET: "from-the-client" });
    server.expireAccessTokens();

    await client!.callTool({ name: "echo" });

    expect(server.tokenRequestLog()).toEqual([{ grantType: "refresh_token", clientId: "ci", clientSecret: "from-the-client", refreshToken: "rt-0" }]);
  });

  it("is missing when the client was given no variables, even if the process has one", async () => {
    await expect(connect()).rejects.toThrow('Client secret env var "NOTION_OAUTH_SECRET" is not set');
    expect(server.count("initialize")).toBe(0);
  });
});
