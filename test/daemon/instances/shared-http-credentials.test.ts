import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CredentialStore } from "../../../src/credentials/credential-store.js";
import { oauthCredentialKey } from "../../../src/oauth/client-secret.js";
import { awaitConnectedClient } from "../../../src/server/upstream-wait.js";
import { ECHOED, type CountingUpstream } from "../../_helpers/counting-http-upstream.js";
import { HAS_OPENSSL, selfSignedCertificate } from "../../_helpers/self-signed.js";
import { LockedKeychain, MASTER_KEY, useSharedHttpFixture, type TestBridge } from "../../_helpers/shared-http-fixture.js";

describe.skipIf(process.platform === "win32")("credentials and network settings of HTTP upstreams shared through daemon instances", { timeout: 30_000 }, () => {
  const fixture = useSharedHttpFixture();
  const { daemon, upstream, writeJson, bridge, status, storeFor, storeOAuth, credentialsPath } = fixture;

  async function connectWithStoredHeader(): Promise<{ client: TestBridge; server: CountingUpstream }> {
    const server = await upstream();
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url, headers: { Authorization: "Bearer ${credential:token}" } } } });
    return { client: await bridge(config), server };
  }

  function connectFailure(client: TestBridge): string | undefined {
    return client.lines.find((line) => line.message.startsWith("failed to connect"))?.message;
  }

  it("gives a client with another master key its own instance and connection", async () => {
    await daemon();
    const server = await upstream();
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } } });

    await bridge(config);
    await bridge(config, { env: { MCP_BRIDGE_MASTER_KEY: randomBytes(32).toString("hex") } });

    expect((await status()).instances).toHaveLength(2);
    expect(server.count("tools/list")).toBe(2);
  });

  it("resolves ${credential:...} headers in the daemon, with the new value after the credential changes", async () => {
    await daemon();
    const server = await upstream({ era: "legacy" });
    const store = storeFor({ MCP_BRIDGE_MASTER_KEY: MASTER_KEY });
    await store.set("token", { type: "secret", value: "one" });
    const config = await writeJson("bridge.json", {
      mcpServers: { svc: { url: server.url, headers: { Authorization: "Bearer ${credential:token}" } } },
      _bridge: { healthCheckInterval: 1 },
    });
    await bridge(config);
    expect(server.authorizations().at(-1)).toBe("Bearer one");

    await store.set("token", { type: "secret", value: "two" });
    await server.endSessions();

    await vi.waitFor(() => expect(server.authorizations()).toContain("Bearer two"), { timeout: 15_000 });
  });

  it("refreshes stored tokens of an upstream without _bridge.auth once when both clients call as they expire", async () => {
    await daemon();
    const server = await upstream({ oauth: true });
    const store = storeFor({ MCP_BRIDGE_MASTER_KEY: MASTER_KEY });
    await storeOAuth(store, "svc", server, "at-0", "rt-0");
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } } });
    const [a, b] = [await bridge(config), await bridge(config)];
    expect(await a.call("svc")).toEqual(ECHOED);

    server.expireAccessToken();

    expect(await Promise.all([a.call("svc"), b.call("svc")])).toEqual([ECHOED, ECHOED]);
    expect(server.tokenRequests()).toBe(1);
    const stored = await store.get(oauthCredentialKey("svc"));
    expect(stored).toMatchObject({ refresh_token: "rt-1" });
  });

  it("refreshes once for three clients making three calls each as the tokens expire, without tripping the refresh circuit breaker", async () => {
    await daemon();
    const server = await upstream({ oauth: true });
    const store = storeFor({ MCP_BRIDGE_MASTER_KEY: MASTER_KEY });
    await storeOAuth(store, "svc", server, "at-0", "rt-0");
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } } });
    const clients = [await bridge(config), await bridge(config), await bridge(config)];
    expect(await clients[0]!.call("svc")).toEqual(ECHOED);

    server.expireAccessToken();
    const results = await Promise.all(clients.flatMap((each) => [each.call("svc"), each.call("svc"), each.call("svc")]));

    expect(results).toEqual(Array(9).fill(ECHOED));
    expect(server.tokenRequests()).toBe(1);
    expect(clients.map((each) => each.client("svc").status)).toEqual(["connected", "connected", "connected"]);
    expect(fixture.daemonLines.map((line) => line.message).join("\n")).not.toContain("circuit breaker");
    expect(await store.get(oauthCredentialKey("svc"))).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
  });

  it("pauses an upstream that needs authorization for every client, and serves the next call once it is authorized again", async () => {
    await daemon();
    const server = await upstream({ oauth: true });
    const store = storeFor({ MCP_BRIDGE_MASTER_KEY: MASTER_KEY });
    await storeOAuth(store, "svc", server, "revoked", "revoked-rt");
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url, _bridge: { reconnect: { reconnectBaseDelay: 100 } } } } });
    const bridgesUsingIt = [await bridge(config), await bridge(config)];
    await vi.waitFor(() => expect(bridgesUsingIt.map((b) => b.client("svc").status)).toEqual(["auth_required", "auth_required"]));

    for (const each of bridgesUsingIt) {
      await expect(awaitConnectedClient("svc", { getClient: (name) => each.manager.getClient(name) })).rejects.toThrow("needs re-authorization");
    }
    await storeOAuth(store, "svc", server, "at-0", "rt-0");
    await new Promise((resolve) => setTimeout(resolve, 300));

    for (const each of bridgesUsingIt) {
      const client = await awaitConnectedClient("svc", { getClient: (name) => each.manager.getClient(name) });
      expect((await client.callTool({ name: "echo" })).content).toEqual(ECHOED);
    }
  });

  it("reports the error when the keychain is locked in the daemon, as the bridge would", async () => {
    await daemon({ createCredentialStore: () => new CredentialStore({ keychain: new LockedKeychain(), filePath: credentialsPath() }) });
    await storeFor({ MCP_BRIDGE_MASTER_KEY: MASTER_KEY }).set("token", { type: "secret", value: "one" });

    const { client, server } = await connectWithStoredHeader();

    expect(client.client("svc").status).not.toBe("connected");
    expect(connectFailure(client)).toContain("keychain is locked");
    expect(server.count("tools/list")).toBe(0);
  });

  it("reports the error when the credential store can't be read in the daemon, as the bridge would", async () => {
    await daemon();
    await writeFile(credentialsPath(), "not a credential store");

    const { client, server } = await connectWithStoredHeader();

    expect(client.client("svc").status).not.toBe("connected");
    expect(connectFailure(client)?.toLowerCase()).toContain("corrupted");
    expect(server.count("tools/list")).toBe(0);
  });

  it("tells a client whose extra certificate file can't be read, on its connection's first request", async () => {
    await daemon();
    const server = await upstream();
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } } });

    const a = await bridge(config, { env: { MCP_BRIDGE_MASTER_KEY: MASTER_KEY, NODE_EXTRA_CA_CERTS: join(fixture.dir, "missing.pem") } });

    expect(a.lines).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringContaining("ignoring certificates from NODE_EXTRA_CA_CERTS") }));
    expect(await a.call("svc")).toEqual(ECHOED);
  });

  it.skipIf(!HAS_OPENSSL)("connects each client with its own TLS settings, whatever the daemon's own environment says", async () => {
    await daemon();
    const certificate = selfSignedCertificate(fixture.dir);
    const server = await upstream({ tls: certificate });
    const config = await writeJson("bridge.json", { mcpServers: { svc: { url: server.url } } });
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");

    const strict = await bridge(config);
    const trusting = await bridge(config, { env: { MCP_BRIDGE_MASTER_KEY: MASTER_KEY, NODE_EXTRA_CA_CERTS: certificate.certPath } });

    expect(strict.client("svc").status).not.toBe("connected");
    expect(await trusting.call("svc")).toEqual(ECHOED);
    expect(server.count("tools/list")).toBe(1);
    expect((await status()).instances).toHaveLength(2);
  });
});
