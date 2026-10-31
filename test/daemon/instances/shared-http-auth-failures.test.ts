import { describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { CredentialStore } from "../../../src/credentials/credential-store.js";
import { createKeychainAdapter } from "../../../src/credentials/keychain.js";
import { oauthCredentialKey } from "../../../src/oauth/client-secret.js";
import { acquireLock } from "../../../src/process/lockfile.js";
import { ECHOED } from "../../_helpers/counting-http-upstream.js";
import { BRIDGE_AUTH, callWithRefreshHeld, expectAuthMessage, LockedKeychain, oauthConfig, useSharedHttpFixture } from "../../_helpers/shared-http-fixture.js";

describe.skipIf(process.platform === "win32")("authorization failures of HTTP upstreams shared through daemon instances", { timeout: 30_000 }, () => {
  const fixture = useSharedHttpFixture();
  const { daemon, upstream, authorizedUpstream, writeJson, rewriteJsonUntil, bridge, status, store, credentialsPath } = fixture;
  const stale = { access: "at-stale", refresh: "rt-stale" };

  it("deletes the tokens and pauses for every client when the authorization server rejects the refresh and nobody else refreshed", async () => {
    await daemon();
    const server = await authorizedUpstream("svc", stale);
    const path = await writeJson("bridge.json", oauthConfig(server));
    const clients = [await bridge(path), await bridge(path)];

    await vi.waitFor(() => expect(clients.map((each) => each.client("svc").status)).toEqual(["auth_required", "auth_required"]));
    expect(await store().get(oauthCredentialKey("svc"))).toBeUndefined();
    for (const each of clients) await expectAuthMessage(each);
    expect(server.tokenRequests()).toBe(1);
  });

  it("pauses for every client when the upstream refuses the tokens a refresh just issued", async () => {
    await daemon();
    const server = await authorizedUpstream();
    const path = await writeJson("bridge.json", oauthConfig(server));
    const clients = [await bridge(path), await bridge(path)];
    expect(await clients[0]!.call("svc")).toEqual(ECHOED);
    server.refuseEveryAccessToken(true);

    await expect(clients[0]!.call("svc")).rejects.toThrow();

    await vi.waitFor(() => expect(clients.map((each) => each.client("svc").status)).toEqual(["auth_required", "auth_required"]));
    expect(server.tokenRequests()).toBe(1);
    expect(fixture.daemonLines.filter((line) => line.message.startsWith("authorization required; paused"))).toHaveLength(1);
  });

  it("keeps the tokens and warns, without asking for auth, when the store's lock can't be taken to check them", async () => {
    await daemon({ createCredentialStore: (env) => new CredentialStore({ keychain: createKeychainAdapter({ env }), filePath: credentialsPath(), lockTimeoutMs: 300 }) });
    const server = await authorizedUpstream("svc", stale);
    const lock = await acquireLock(`${credentialsPath()}.lock`);
    try {
      const client = await bridge(await writeJson("bridge.json", oauthConfig(server, { type: "oauth2" })));

      expect(client.client("svc").status).toBe("disconnected");
      expect(fixture.daemonLines).toContainEqual(expect.objectContaining({ level: "warn", message: 'could not check the stored tokens for "svc"; keeping them' }));
    } finally {
      await lock.release();
    }
    expect(await store().get(oauthCredentialKey("svc"))).toMatchObject({ refresh_token: "rt-stale" });
  });

  it("finishes a refresh that was in flight while the config reloaded another server", async () => {
    await daemon();
    const server = await authorizedUpstream();
    const other = await upstream();
    const { call } = await callWithRefreshHeld(server, await bridge(await writeJson("bridge.json", oauthConfig(server))));

    await rewriteJsonUntil("bridge.json", { mcpServers: { svc: { url: server.url, _bridge: { auth: BRIDGE_AUTH } }, other: { url: other.url } } }, async () =>
      expect((await status()).instances[0]!.upstreams).toEqual(["other", "svc"]),
    );
    server.holdRefreshResponses(false);

    expect(await call).toEqual(ECHOED);
    expect(server.tokenRequests()).toBe(1);
    expect((await status()).upstreams.find((each) => each.serverName === "svc")?.status).toBe("connected");
  });

  it("keeps the tokens of a refresh in flight when a reload connects that upstream again", async () => {
    await daemon();
    const server = await authorizedUpstream();
    const client = await bridge(await writeJson("bridge.json", oauthConfig(server)));
    const { call } = await callWithRefreshHeld(server, client);

    await rewriteJsonUntil("bridge.json", oauthConfig(server, { ...BRIDGE_AUTH, scopes: ["read"] }), async () =>
      expect(fixture.daemonLines.map((line) => line.message)).toContain("reconnecting server"),
    );
    server.holdRefreshResponses(false);
    await call;

    await vi.waitFor(async () => expect((await status()).upstreams).toEqual([{ serverName: "svc", type: "streamable-http", status: "connected", instances: 1 }]));
    expect(server.tokenRequests()).toBe(1);
    expect(await store().get(oauthCredentialKey("svc"))).toMatchObject({ refresh_token: "rt-1" });
    expect(await client.call("svc")).toEqual(ECHOED);
  });

  it("saves the tokens of a refresh in flight before it finishes stopping", async () => {
    const running = await daemon();
    const server = await authorizedUpstream();
    await callWithRefreshHeld(server, await bridge(await writeJson("bridge.json", oauthConfig(server))));

    const stopping = running.manager.stop(0, "test");
    setTimeout(() => server.holdRefreshResponses(false), 300);
    await stopping;

    expect(await store().get(oauthCredentialKey("svc"))).toMatchObject({ refresh_token: "rt-1" });
  });

  it("reports a locked keychain in the daemon for an upstream with _bridge.auth", async () => {
    await daemon({ createCredentialStore: () => new CredentialStore({ keychain: new LockedKeychain(), filePath: credentialsPath() }) });
    const server = await authorizedUpstream();
    const client = await bridge(await writeJson("bridge.json", oauthConfig(server)));

    expect(client.client("svc").status).not.toBe("connected");
    expect(client.lines.map((line) => line.message).join("\n")).toContain("keychain is locked");
    expect(server.count("tools/list")).toBe(0);
  });

  it("reports a credential store it can't read for an upstream with _bridge.auth", async () => {
    await daemon();
    const server = await upstream({ oauth: true });
    await writeFile(credentialsPath(), "not a credential store");
    const client = await bridge(await writeJson("bridge.json", oauthConfig(server)));

    expect(client.client("svc").status).not.toBe("connected");
    expect(client.lines.map((line) => line.message).join("\n").toLowerCase()).toContain("corrupted");
    expect(server.count("tools/list")).toBe(0);
  });
});
