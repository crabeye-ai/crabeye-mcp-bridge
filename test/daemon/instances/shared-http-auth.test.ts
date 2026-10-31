import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { oauthCredentialKey } from "../../../src/oauth/client-secret.js";
import { ECHOED, type CountingUpstream } from "../../_helpers/counting-http-upstream.js";
import { BRIDGE_AUTH, MASTER_KEY, useSharedHttpFixture, type TestBridge } from "../../_helpers/shared-http-fixture.js";

describe.skipIf(process.platform === "win32")("token refresh of HTTP upstreams shared through daemon instances", { timeout: 30_000 }, () => {
  const fixture = useSharedHttpFixture();
  const { daemon, authorizedUpstream, writeJson, rewriteJsonUntil, bridge, status, store } = fixture;
  const withExtraCertificates = () => ({ MCP_BRIDGE_MASTER_KEY: MASTER_KEY, NODE_EXTRA_CA_CERTS: join(fixture.dir, "extra.pem") });

  /** Expires the tokens and calls from every client at once, holding the refresh until each client's call has been refused. */
  async function callAsTheTokensExpire(server: CountingUpstream, clients: TestBridge[]): Promise<unknown[]> {
    const refused = server.unauthorizedResponses();
    server.holdRefreshResponses(true);
    server.expireAccessTokens();
    const calls = clients.map((client) => client.call("svc"));
    await vi.waitFor(() => expect(server.unauthorizedResponses()).toBeGreaterThanOrEqual(refused + clients.length));
    await vi.waitFor(() => expect(server.heldRefreshResponses()).toBe(1));
    server.holdRefreshResponses(false);
    return Promise.all(calls);
  }

  it("refreshes the tokens of an upstream with _bridge.auth once when two clients on the default config call as they expire", async () => {
    await daemon();
    const server = await authorizedUpstream();
    const clientFile = await writeJson("client.json", { mcpServers: { svc: { url: server.url, _bridge: { auth: BRIDGE_AUTH } } } });
    const config = await writeJson("config.json", { configPaths: [clientFile] });
    const [a, b] = [await bridge(config, { kind: "merged" }), await bridge(config, { kind: "merged" })];
    expect(await a.call("svc")).toEqual(ECHOED);

    expect(await callAsTheTokensExpire(server, [a, b])).toEqual([ECHOED, ECHOED]);

    expect(server.tokenRequests()).toBe(1);
    expect(await store().get(oauthCredentialKey("svc"))).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
  });

  it("shares one connection and one refresh between a default-config client and one whose own config names the same server the same way", async () => {
    await daemon();
    const server = await authorizedUpstream();
    const servers = { mcpServers: { svc: { url: server.url, _bridge: { auth: BRIDGE_AUTH } } } };
    const config = await writeJson("config.json", { configPaths: [await writeJson("client.json", servers)] });
    const [a, b] = [await bridge(config, { kind: "merged" }), await bridge(await writeJson("other.json", servers))];
    expect((await status()).upstreams).toEqual([{ serverName: "svc", type: "streamable-http", status: "connected", instances: 2 }]);

    expect(await callAsTheTokensExpire(server, [a, b])).toEqual([ECHOED, ECHOED]);
    expect(server.tokenRequests()).toBe(1);
    expect(server.count("tools/list")).toBe(1);
  });

  it.each([
    ["their network settings, with _bridge.auth", { _bridge: { auth: BRIDGE_AUTH } }, {}, withExtraCertificates],
    ["their network settings, without _bridge.auth", {}, {}, withExtraCertificates],
    ["their configs' headers", { _bridge: { auth: BRIDGE_AUTH } }, { headers: { "X-Client": "b" } }, undefined],
  ])("refreshes once for two connections to one server that %s keep apart", async (_label, shared, second, env) => {
    await daemon();
    const server = await authorizedUpstream();
    const a = await bridge(await writeJson("bridge.json", { mcpServers: { svc: { url: server.url, ...shared } } }));
    const b = await bridge(await writeJson("other.json", { mcpServers: { svc: { url: server.url, ...shared, ...second } } }), env && { env: env() });
    expect(await Promise.all([a.call("svc"), b.call("svc")])).toEqual([ECHOED, ECHOED]);
    expect((await status()).upstreams.map((each) => each.serverName)).toEqual(["svc", "svc"]);

    expect(await callAsTheTokensExpire(server, [a, b])).toEqual([ECHOED, ECHOED]);

    expect(server.tokenRequests()).toBe(1);
    expect(fixture.daemonLines.filter((line) => line.level === "warn" && line.message.includes("refresh"))).toEqual([]);
  });

  it("refreshes at each token endpoint, even when two servers' stored tokens carry the same refresh token", async () => {
    await daemon();
    const [first, second] = [await authorizedUpstream("first"), await authorizedUpstream("second")];
    const config = await writeJson("bridge.json", {
      mcpServers: { first: { url: first.url, _bridge: { auth: BRIDGE_AUTH } }, second: { url: second.url, _bridge: { auth: BRIDGE_AUTH } } },
    });
    const client = await bridge(config);
    first.expireAccessTokens();
    second.expireAccessTokens();

    expect(await Promise.all([client.call("first"), client.call("second")])).toEqual([ECHOED, ECHOED]);

    expect([first.tokenRequests(), second.tokenRequests()]).toEqual([1, 1]);
  });

  it("connects an upstream again with its new settings when its _bridge.auth changes", async () => {
    await daemon();
    const server = await authorizedUpstream();
    const client = await bridge(await writeJson("bridge.json", { mcpServers: { svc: { url: server.url, _bridge: { auth: BRIDGE_AUTH } } } }));
    expect(await client.call("svc")).toEqual(ECHOED);

    await rewriteJsonUntil("bridge.json", { mcpServers: { svc: { url: server.url, _bridge: { auth: { ...BRIDGE_AUTH, clientId: "client-2" } } } } }, async () =>
      expect(server.count("tools/list")).toBe(2),
    );
    await vi.waitFor(async () => expect((await status()).upstreams).toEqual([{ serverName: "svc", type: "streamable-http", status: "connected", instances: 1 }]));
    server.expireAccessTokens();

    expect(await client.call("svc")).toEqual(ECHOED);
    expect(server.tokenRequestLog().map((request) => request.clientId)).toEqual(["client-2"]);
    expect(fixture.daemonLines).toContainEqual(expect.objectContaining({ message: "reconnecting server", context: expect.objectContaining({ server: "svc" }) }));
  });

  describe("with a client secret from the client's environment", () => {
    const secretConfig = (server: CountingUpstream) => ({
      mcpServers: { svc: { url: server.url, _bridge: { auth: { ...BRIDGE_AUTH, clientSecret: "${NOTION_OAUTH_SECRET}" } } } },
    });

    it("sends the client's secret, not one in the daemon's own environment, and gives a client with another secret its own connection", async () => {
      await daemon();
      vi.stubEnv("NOTION_OAUTH_SECRET", "daemon-secret");
      const server = await authorizedUpstream();
      const config = await writeJson("bridge.json", secretConfig(server));
      const a = await bridge(config, { env: { MCP_BRIDGE_MASTER_KEY: MASTER_KEY, NOTION_OAUTH_SECRET: "secret-a" } });
      server.expireAccessTokens();
      expect(await a.call("svc")).toEqual(ECHOED);

      const b = await bridge(config, { env: { MCP_BRIDGE_MASTER_KEY: MASTER_KEY, NOTION_OAUTH_SECRET: "secret-b" } });
      server.expireAccessTokens();
      expect(await b.call("svc")).toEqual(ECHOED);

      expect(server.tokenRequestLog().map((request) => request.clientSecret)).toEqual(["secret-a", "secret-b"]);
      const { instances, upstreams } = await status();
      expect(instances).toHaveLength(2);
      expect(upstreams).toHaveLength(2);
    });

    it("reports a client secret variable the client doesn't set, by name and never by a value", async () => {
      await daemon();
      vi.stubEnv("NOTION_OAUTH_SECRET", "daemon-secret");
      const server = await authorizedUpstream();
      const client = await bridge(await writeJson("bridge.json", secretConfig(server)));

      expect(client.client("svc").status).not.toBe("connected");
      expect(client.lines.map((line) => line.message).join("\n")).toContain('Client secret env var "NOTION_OAUTH_SECRET" is not set');
      expect(JSON.stringify([client.lines, fixture.daemonLines])).not.toContain("daemon-secret");
      expect(server.count("tools/list")).toBe(0);
    });

    it("refuses a client secret variable that isn't allowed, by name", async () => {
      await daemon();
      const server = await authorizedUpstream();
      const config = { mcpServers: { svc: { url: server.url, _bridge: { auth: { ...BRIDGE_AUTH, clientSecret: "${AWS_SECRET_ACCESS_KEY}" } } } } };
      const client = await bridge(await writeJson("bridge.json", config));

      expect(client.client("svc").status).not.toBe("connected");
      expect(client.lines.map((line) => line.message).join("\n")).toContain('Client secret env var "AWS_SECRET_ACCESS_KEY" is not allowed');
    });
  });
});
