import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { networkFetch, type NetworkFetch } from "../../src/daemon/instances/network.js";
import { networkSettings } from "../../src/daemon/instance-env.js";
import { oauthCredentialKey } from "../../src/oauth/client-secret.js";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import type { HttpServerConfig } from "../../src/config/schema.js";
import { ECHOED, startCountingUpstream, type CountingUpstream } from "../_helpers/counting-http-upstream.js";
import { makeTestStore, type TestStoreHandle } from "../_helpers/credential-store.js";
import { spyLogger } from "../_helpers/spy-logger.js";

describe("an HTTP upstream that redirects", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function upstream(options: Parameters<typeof startCountingUpstream>[0]): Promise<CountingUpstream> {
    const server = await startCountingUpstream(options);
    cleanups.push(() => server.close());
    return server;
  }

  async function redirectingEverythingTo(target: string): Promise<string> {
    const front = http.createServer((_req, res) => {
      res.writeHead(307, { location: target });
      res.end();
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => front.close(() => resolve())));
    return `http://127.0.0.1:${(front.address() as AddressInfo).port}/mcp`;
  }

  function client(config: HttpServerConfig, store?: TestStoreHandle): HttpUpstreamClient {
    const network: NetworkFetch = networkFetch(networkSettings({}), spyLogger());
    const created = new HttpUpstreamClient({
      name: "svc",
      config,
      fetch: network.fetch,
      logger: spyLogger(),
      reconnectBaseDelay: 60_000,
      ...(store && { credentialStore: store.store }),
    });
    cleanups.push(async () => {
      await created.close();
      await network.close();
    });
    return created;
  }

  it.each(["streamable-http", "sse"] as const)("refuses a redirect to another origin over %s, saying to configure the address it points to", async (type) => {
    const target = await upstream({});
    const url = await redirectingEverythingTo(target.url);

    const failed = client({ type, url }).connect();

    await expect(failed).rejects.toThrow(`Redirect to ${target.url} not followed; use that URL as this server's "url" if it is the intended server`);
    await expect(failed).rejects.not.toThrow("redirectPolicy");
    expect(target.paths()).toEqual([]);
  });

  it.each(["modern", "legacy"] as const)("follows a redirect within the server's origin, on a %s connection", async (era) => {
    const server = await upstream({ era, redirects: { "/old": "/mcp" } });
    const redirected = client({ type: "streamable-http", url: server.url.replace(/\/mcp$/, "/old") });

    await redirected.connect();

    expect((await redirected.callTool({ name: "echo" })).content).toEqual(ECHOED);
    expect(server.paths().filter((path) => path === "/old").length).toBe(server.paths().filter((path) => path === "/mcp").length);
  });

  it("follows OAuth discovery documents redirected within the server's origin when refreshing", async () => {
    const server = await upstream({
      oauth: true,
      redirects: {
        "/.well-known/oauth-protected-resource/mcp": "/.well-known/oauth-protected-resource/moved",
        "/.well-known/oauth-authorization-server": "/.well-known/oauth-authorization-server/moved",
      },
    });
    const store = makeTestStore("crabeye-redirects-");
    cleanups.push(() => store.cleanup());
    await store.store.set(oauthCredentialKey("svc"), { type: "oauth2", access_token: "at-0", refresh_token: "rt-0", token_type: "Bearer", issuer: server.issuer });
    const oauthClient = client({ type: "streamable-http", url: server.url, _bridge: { auth: { type: "oauth2", clientId: "ci" } } }, store);
    await oauthClient.connect();

    server.expireAccessTokens();

    expect((await oauthClient.callTool({ name: "echo" })).content).toEqual(ECHOED);
    expect(server.tokenRequests()).toBe(1);
    expect(server.paths()).toEqual(expect.arrayContaining(["/.well-known/oauth-protected-resource/moved", "/.well-known/oauth-authorization-server/moved"]));
  });
});
