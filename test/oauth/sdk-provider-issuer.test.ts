import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import { BridgeOAuthClientProvider } from "../../src/oauth/sdk-provider.js";
import { clientInfoKey, clientIssuerKey, oauthCredentialKey } from "../../src/oauth/client-secret.js";
import { makeTestStore } from "../_helpers/credential-store.js";

const REDIRECT = "http://127.0.0.1:54321/callback";
const ISSUER = "https://as.example.com";

describe("BridgeOAuthClientProvider issuer binding", () => {
  let store: CredentialStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("sdk-provider-issuer-"));
  });

  afterEach(() => {
    cleanup();
  });

  it("records the first issuer seen for a config-supplied client, without the secret", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
      clientSecret: "shh",
    });

    expect(await provider.clientInformation({ issuer: ISSUER })).toEqual({
      client_id: "ci",
      client_secret: "shh",
      issuer: ISSUER,
    });

    expect(await store.get(clientInfoKey("srv"))).toBeUndefined();
    const stamped = await store.get(clientIssuerKey("srv"));
    expect(JSON.parse((stamped as { value: string }).value)).toEqual({
      client_id: "ci",
      issuer: ISSUER,
    });

    expect(await provider.clientInformation({ issuer: ISSUER })).toEqual({
      client_id: "ci",
      client_secret: "shh",
      issuer: ISSUER,
    });
  });

  it("never clobbers an existing dynamic registration with the config stamp", async () => {
    await store.set(clientInfoKey("srv"), {
      type: "secret",
      value: JSON.stringify({ client_id: "dyn-1", client_secret: "dcr-secret" }),
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });

    await provider.clientInformation({ issuer: ISSUER });

    expect(JSON.parse(((await store.get(clientInfoKey("srv"))) as { value: string }).value)).toEqual({
      client_id: "dyn-1",
      client_secret: "dcr-secret",
    });
  });

  it("refuses to hand config credentials to a different authorization server", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
      clientSecret: "shh",
    });
    await provider.clientInformation({ issuer: ISSUER });

    const failure = await provider
      .clientInformation({ issuer: "https://evil.example.com/INJECTED" })
      .then(() => undefined, (err: Error) => err);
    expect(failure?.message).toMatch(/no longer https:\/\/as\.example\.com.*mix-up.*auth --remove srv/s);
    expect(failure?.message).not.toContain("INJECTED");
  });

  it("rebinds when the configured client_id changed (credentials were replaced)", async () => {
    await store.set(clientIssuerKey("srv"), {
      type: "secret",
      value: JSON.stringify({ client_id: "old-client", issuer: ISSUER }),
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "new-client",
    });

    await expect(
      provider.clientInformation({ issuer: "https://new-as.example.com" }),
    ).resolves.toMatchObject({ client_id: "new-client", issuer: "https://new-as.example.com" });

    const rebound = await store.get(clientIssuerKey("srv"));
    expect(JSON.parse((rebound as { value: string }).value)).toEqual({
      client_id: "new-client",
      issuer: "https://new-as.example.com",
    });
    await expect(
      provider.clientInformation({ issuer: "https://evil.example.com" }),
    ).rejects.toThrow(/no longer/);
  });

  it("at runtime, deletes a corrupt registration and refuses rather than re-registering", async () => {
    await store.set(clientInfoKey("srv"), { type: "secret", value: "{not json" });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      runtime: true,
    });

    await expect(provider.clientInformation({ issuer: ISSUER })).rejects.toThrow(
      /not available at runtime/,
    );
    expect(await store.get(clientInfoKey("srv"))).toBeUndefined();
  });

  it("allows an identical re-stamp from a concurrent auth() call", async () => {
    await store.set(clientInfoKey("srv"), {
      type: "secret",
      value: JSON.stringify({ client_id: "dyn-1" }),
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      runtime: true,
    });

    await provider.saveClientInformation({ client_id: "dyn-1", issuer: ISSUER });
    await expect(
      provider.saveClientInformation({ client_id: "dyn-1", issuer: ISSUER }),
    ).resolves.toBeUndefined();
  });

  it("refuses at runtime before the SDK can POST a dynamic registration", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      runtime: true,
    });
    await expect(provider.clientInformation({ issuer: ISSUER })).rejects.toThrow(
      /not available at runtime/,
    );

    await store.set(clientInfoKey("srv"), {
      type: "secret",
      value: JSON.stringify({ client_id: "dyn-1", issuer: ISSUER }),
    });
    await expect(
      provider.clientInformation({ issuer: "https://other.example.com" }),
    ).rejects.toThrow(/not available at runtime/);

    await expect(provider.clientInformation({ issuer: ISSUER })).resolves.toMatchObject({
      client_id: "dyn-1",
    });
  });

  it("tolerates a trailing-slash difference the way the SDK does", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    await provider.clientInformation({ issuer: `${ISSUER}/` });

    await expect(
      provider.clientInformation({ issuer: ISSUER }),
    ).resolves.toMatchObject({ client_id: "ci" });
  });

  it("clears the config issuer binding on invalidateCredentials", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
    });
    await provider.clientInformation({ issuer: ISSUER });
    expect(await store.get(clientIssuerKey("srv"))).toBeDefined();

    await provider.invalidateCredentials("client");
    expect(await store.get(clientIssuerKey("srv"))).toBeUndefined();

    await expect(
      provider.clientInformation({ issuer: "https://other.example.com" }),
    ).resolves.toMatchObject({ issuer: "https://other.example.com" });
  });

  it("never persists config-supplied client credentials", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      clientId: "ci",
      clientSecret: "shh",
      runtime: true,
    });
    await provider.saveClientInformation({ client_id: "ci", client_secret: "shh", issuer: ISSUER });
    expect(await store.get(clientInfoKey("srv"))).toBeUndefined();
  });

  it("allows the runtime provider to stamp an existing dynamic registration", async () => {
    await store.set(clientInfoKey("srv"), {
      type: "secret",
      value: JSON.stringify({ client_id: "dyn-1" }),
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      runtime: true,
    });

    await provider.saveClientInformation({ client_id: "dyn-1", issuer: ISSUER });

    const stored = await store.get(clientInfoKey("srv"));
    expect(stored?.type).toBe("secret");
    expect(JSON.parse((stored as { value: string }).value)).toEqual({
      client_id: "dyn-1",
      issuer: ISSUER,
    });
  });

  it("still refuses a new dynamic registration at runtime", async () => {
    await store.set(clientInfoKey("srv"), {
      type: "secret",
      value: JSON.stringify({ client_id: "dyn-1" }),
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      runtime: true,
    });
    await expect(
      provider.saveClientInformation({ client_id: "dyn-2", issuer: ISSUER }),
    ).rejects.toThrow(/Dynamic client registration is not available at runtime/);
  });

  it("refuses to re-stamp an already-bound registration to a different issuer", async () => {
    await store.set(clientInfoKey("srv"), {
      type: "secret",
      value: JSON.stringify({ client_id: "dyn-1", issuer: ISSUER }),
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      runtime: true,
    });

    await expect(
      provider.saveClientInformation({
        client_id: "dyn-1",
        issuer: "https://evil.example.com",
      }),
    ).rejects.toThrow(/Dynamic client registration is not available at runtime/);

    expect(JSON.parse(((await store.get(clientInfoKey("srv"))) as { value: string }).value)).toEqual({
      client_id: "dyn-1",
      issuer: ISSUER,
    });
  });

  it("refuses a runtime re-registration that reuses the client_id but changes fields", async () => {
    await store.set(clientInfoKey("srv"), {
      type: "secret",
      value: JSON.stringify({ client_id: "dyn-1", client_secret: "honest" }),
    });
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
      runtime: true,
    });

    await expect(
      provider.saveClientInformation({
        client_id: "dyn-1",
        client_secret: "attacker",
        issuer: ISSUER,
      }),
    ).rejects.toThrow(/Dynamic client registration is not available at runtime/);

    const stored = await store.get(clientInfoKey("srv"));
    expect(JSON.parse((stored as { value: string }).value)).toEqual({
      client_id: "dyn-1",
      client_secret: "honest",
    });
  });

  it("round-trips the token issuer through the credential store", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
    });
    await provider.saveTokens(
      { access_token: "at", token_type: "Bearer", expires_in: 3600 },
      { issuer: ISSUER },
    );
    expect((await store.get(oauthCredentialKey("srv")))).toMatchObject({ issuer: ISSUER });
    expect(await provider.tokens()).toMatchObject({ access_token: "at", issuer: ISSUER });
  });

  it("prefers an explicit issuer on the tokens over the context", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
    });
    await provider.saveTokens(
      { access_token: "at", token_type: "Bearer", issuer: ISSUER },
      { issuer: "https://other.example.com" },
    );
    expect(await provider.tokens()).toMatchObject({ issuer: ISSUER });
  });

  it("keeps discovery state in memory and clears it on the discovery / all scopes", async () => {
    const provider = new BridgeOAuthClientProvider({
      serverName: "srv",
      store,
      redirectUrl: REDIRECT,
    });
    const state = { authorizationServerUrl: ISSUER, resourceMetadataUrl: "https://rs.example.com/.well-known" } as never;

    expect(provider.discoveryState()).toBeUndefined();
    provider.saveDiscoveryState(state);
    expect(provider.discoveryState()).toBe(state);

    await provider.invalidateCredentials("tokens");
    expect(provider.discoveryState()).toBe(state);

    await provider.invalidateCredentials("discovery");
    expect(provider.discoveryState()).toBeUndefined();

    provider.saveDiscoveryState(state);
    await provider.invalidateCredentials("all");
    expect(provider.discoveryState()).toBeUndefined();
  });
});
