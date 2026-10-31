import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { clientInfoKey, oauthCredentialKey } from "../../../src/oauth/client-secret.js";
import { BridgeOAuthClientProvider } from "../../../src/oauth/sdk-provider.js";
import { HttpUpstreamClient } from "../../../src/upstream/http-client.js";
import { ECHOED, type CountingUpstream } from "../../_helpers/counting-http-upstream.js";
import type { DaemonFixture } from "../../_helpers/daemon-fixtures.js";
import { BRIDGE_AUTH, callWithRefreshHeld, expectAuthMessage, MASTER_KEY, oauthConfig, storeOAuth, useSharedHttpFixture } from "../../_helpers/shared-http-fixture.js";

const DROPPED = 'dropped the tokens of a refresh for "svc" after the stored tokens changed';

describe.skipIf(process.platform === "win32")("HTTP upstreams shared through daemon instances, told their credentials changed", { timeout: 30_000 }, () => {
  const fixture = useSharedHttpFixture();
  const { daemon, upstream, authorizedUpstream, writeJson, rewriteJsonUntil, bridge, status, store } = fixture;
  let manager: DaemonFixture;

  const tellAuthChanged = () => manager.client.call("AUTH_CHANGED", { upstream: "svc" });
  const removeCredentials = () => store().deleteMany([oauthCredentialKey("svc"), clientInfoKey("svc")]);

  async function grant(server: CountingUpstream, body: Record<string, string>): Promise<{ access_token: string; refresh_token: string }> {
    return (await fetch(`${server.issuer}/token`, { method: "POST", body: new URLSearchParams({ client_id: BRIDGE_AUTH.clientId, ...body }) })).json();
  }

  async function codeGrant(server: CountingUpstream): Promise<{ access_token: string; refresh_token: string }> {
    const authorize = new URL(`${server.issuer}/authorize`);
    authorize.searchParams.set("redirect_uri", "http://127.0.0.1/callback");
    authorize.searchParams.set("state", "s");
    const redirect = await fetch(authorize, { redirect: "manual" });
    const code = new URL(redirect.headers.get("location")!).searchParams.get("code")!;
    return grant(server, { grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1/callback" });
  }

  it("connects a paused upstream for every client, on every connection to it, before any client calls it", async () => {
    manager = await daemon();
    const server = await upstream({ oauth: true });
    const path = await writeJson("bridge.json", oauthConfig(server));
    const clients = [await bridge(path), await bridge(path, { env: { MCP_BRIDGE_MASTER_KEY: MASTER_KEY, NODE_EXTRA_CA_CERTS: join(fixture.dir, "x.pem") } })];
    await vi.waitFor(() => expect(clients.map((each) => each.client("svc").status)).toEqual(["auth_required", "auth_required"]));
    await storeOAuth(store(), "svc", server, "at-0", "rt-0");

    expect(await tellAuthChanged()).toEqual({ connections: 2 });

    expect((await status()).upstreams.map((each) => each.status)).toEqual(["connected", "connected"]);
    expect(server.count("tools/call")).toBe(0);
    expect(await Promise.all(clients.map((each) => each.call("svc")))).toEqual([ECHOED, ECHOED]);
  });

  it.each([
    ["with _bridge.auth", BRIDGE_AUTH],
    ["without _bridge.auth", null],
  ])("pauses a connected upstream %s for every client at once when its credentials were removed", async (_label, auth) => {
    manager = await daemon();
    const server = await authorizedUpstream();
    const path = await writeJson("bridge.json", oauthConfig(server, auth));
    const clients = [await bridge(path), await bridge(path)];
    expect(await clients[0]!.call("svc")).toEqual(ECHOED);
    await removeCredentials();

    expect(await tellAuthChanged()).toEqual({ connections: 1 });

    expect((await status()).upstreams).toEqual([{ serverName: "svc", type: "streamable-http", status: "auth_required", instances: 1 }]);
    for (const each of clients) await expectAuthMessage(each);
  });

  it("keeps the tokens auth stored when a refresh in flight on the connection it replaces finishes afterwards", async () => {
    manager = await daemon();
    const server = await authorizedUpstream();
    const { call } = await callWithRefreshHeld(server, await bridge(await writeJson("bridge.json", oauthConfig(server))));
    const fresh = await codeGrant(server);
    await storeOAuth(store(), "svc", server, fresh.access_token, fresh.refresh_token);

    expect(await tellAuthChanged()).toEqual({ connections: 1 });
    server.holdRefreshResponses(false);

    expect(String(await call)).toContain("Connection closed");
    await vi.waitFor(() => expect(fixture.daemonLines.map((line) => line.message)).toContain(DROPPED));
    expect(await store().get(oauthCredentialKey("svc"))).toMatchObject({ access_token: fresh.access_token, refresh_token: fresh.refresh_token });
    expect((await status()).upstreams).toEqual([{ serverName: "svc", type: "streamable-http", status: "connected", instances: 1 }]);
  });

  it("keeps the credentials removed when a refresh in flight on the connection it replaces finishes afterwards", async () => {
    manager = await daemon();
    const server = await authorizedUpstream();
    const { call } = await callWithRefreshHeld(server, await bridge(await writeJson("bridge.json", oauthConfig(server))));
    const other = await bridge(await writeJson("other.json", oauthConfig(server)));
    await removeCredentials();

    expect(await tellAuthChanged()).toEqual({ connections: 1 });
    server.holdRefreshResponses(false);
    await call;

    await vi.waitFor(() => expect(fixture.daemonLines.map((line) => line.message)).toContain(DROPPED));
    expect(await store().get(oauthCredentialKey("svc"))).toBeUndefined();
    await expectAuthMessage(other);
  });

  it("keeps the credentials removed when a refresh in flight finishes on a connection a reload is closing", async () => {
    manager = await daemon();
    const server = await authorizedUpstream();
    const { call } = await callWithRefreshHeld(server, await bridge(await writeJson("bridge.json", oauthConfig(server))));
    await rewriteJsonUntil("bridge.json", oauthConfig(server, BRIDGE_AUTH, { headers: { "X-Edited": "1" } }), async () =>
      expect(fixture.daemonLines.map((line) => line.message)).toContain("reconnecting server"),
    );
    await removeCredentials();
    const retired = vi.spyOn(HttpUpstreamClient.prototype, "retireAuth");

    const told = tellAuthChanged();
    await vi.waitFor(() => expect(retired).toHaveBeenCalledTimes(2));
    server.holdRefreshResponses(false);
    expect(await told).toEqual({ connections: 1 });
    await call;

    await vi.waitFor(() => expect(fixture.daemonLines.filter((line) => line.message === DROPPED)).toHaveLength(2));
    expect(await store().get(oauthCredentialKey("svc"))).toBeUndefined();
  });

  it("connects with the new tokens, without telling any client it was paused, when told while a connect waits on a refresh", async () => {
    manager = await daemon();
    const server = await authorizedUpstream();
    server.expireAccessTokens();
    server.holdRefreshResponses(true);
    const attaching = bridge(await writeJson("bridge.json", oauthConfig(server)));
    await vi.waitFor(() => expect(server.heldRefreshResponses()).toBe(1));
    const fresh = await codeGrant(server);
    await storeOAuth(store(), "svc", server, fresh.access_token, fresh.refresh_token);
    const retired = vi.spyOn(HttpUpstreamClient.prototype, "retireAuth");

    const told = tellAuthChanged();
    await vi.waitFor(() => expect(retired).toHaveBeenCalled());
    server.holdRefreshResponses(false);
    expect(await told).toEqual({ connections: 1 });
    const client = await attaching;

    expect(await client.call("svc")).toEqual(ECHOED);
    expect(fixture.daemonLines.filter((line) => line.message.startsWith("authorization required"))).toEqual([]);
    expect(client.lines.filter((line) => line.message.includes("authorization required"))).toEqual([]);
  });

  it("doesn't let the connection it replaces redeem the refresh token auth just stored", async () => {
    manager = await daemon();
    const server = await authorizedUpstream();
    const client = await bridge(await writeJson("bridge.json", oauthConfig(server)));
    expect(await client.call("svc")).toEqual(ECHOED);
    server.expireAccessTokens();
    const refreshedByAuth = await grant(server, { grant_type: "refresh_token", refresh_token: "rt-0" });
    server.holdRefreshResponses(true);
    const call = client.call("svc").catch((err: unknown) => err);
    await vi.waitFor(() => expect(server.heldRefreshResponses()).toBe(1));
    await storeOAuth(store(), "svc", server, refreshedByAuth.access_token, refreshedByAuth.refresh_token);

    const askedForAuthorization = vi.spyOn(BridgeOAuthClientProvider.prototype, "redirectToAuthorization");
    expect(await tellAuthChanged()).toEqual({ connections: 1 });
    server.holdRefreshResponses(false);
    await call;
    await vi.waitFor(() => expect(askedForAuthorization).toHaveBeenCalled());

    expect(server.tokenRequestLog().map((request) => request.refreshToken)).toEqual(["rt-0", "rt-0"]);
    expect(await store().get(oauthCredentialKey("svc"))).toMatchObject({ refresh_token: refreshedByAuth.refresh_token });
    expect(await client.call("svc")).toEqual(ECHOED);
  });
});
