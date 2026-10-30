import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import { oauthCredentialKey } from "../../src/oauth/index.js";
import { clientInfoKey, clientIssuerKey } from "../../src/oauth/client-secret.js";
import { BridgeOAuthClientProvider, type BridgeOAuthProviderOptions } from "../../src/oauth/sdk-provider.js";
import { PendingSaves } from "../../src/oauth/pending-saves.js";
import { makeTestStore } from "../_helpers/credential-store.js";
import { settledWithin } from "../_helpers/processes.js";
import { spyLogger, type SpyLogger } from "../_helpers/spy-logger.js";

const TOKENS = { access_token: "at-1", token_type: "Bearer", refresh_token: "rt-1" };
const DROPPED = 'dropped the tokens of a refresh for "srv" after the stored tokens changed';

describe("BridgeOAuthClientProvider and tokens stored elsewhere", () => {
  let store: CredentialStore;
  let cleanup: () => void;
  let logger: SpyLogger;
  let retirement: AbortController;
  let provider: BridgeOAuthClientProvider;

  const providerWith = (opts: Partial<BridgeOAuthProviderOptions> = {}) =>
    new BridgeOAuthClientProvider({ serverName: "srv", store, redirectUrl: "http://127.0.0.1/callback", clientId: "ci", runtime: true, logger, ...opts });

  const refreshThrough = (refreshing: BridgeOAuthClientProvider, refreshToken = "rt-0") =>
    refreshing.wrapFetch(async () => Response.json(TOKENS))("https://as.example/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });

  const storeTokens = (access: string, refresh: string) => store.set(oauthCredentialKey("srv"), { type: "oauth2", access_token: access, refresh_token: refresh });

  beforeEach(() => {
    ({ store, cleanup } = makeTestStore("sdk-provider-stale-"));
    logger = spyLogger();
    retirement = new AbortController();
    provider = providerWith({ retirement: retirement.signal });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  describe("saving the tokens of a refresh", () => {
    it("doesn't write them over tokens stored after the refresh began, such as by auth", async () => {
      await storeTokens("at-0", "rt-0");
      await refreshThrough(provider);
      await storeTokens("at-auth", "rt-auth");

      await provider.saveTokens(TOKENS);

      expect(await store.get(oauthCredentialKey("srv"))).toMatchObject({ access_token: "at-auth", refresh_token: "rt-auth" });
      expect(logger.info).toHaveBeenCalledWith(DROPPED, { component: "oauth" });
    });

    it("restores them where another process deleted the tokens it refreshed", async () => {
      await storeTokens("at-0", "rt-0");
      await refreshThrough(provider);
      await store.delete(oauthCredentialKey("srv"));

      await provider.saveTokens(TOKENS);

      expect(await store.get(oauthCredentialKey("srv"))).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
    });

    it("says the save finished, so a closing connection stops waiting for it", async () => {
      const pendingSaves = new PendingSaves();
      const counted = providerWith({ pendingSaves });
      await refreshThrough(counted);

      await counted.saveTokens(TOKENS);

      expect(await settledWithin(pendingSaves.settled(), 1_000)).toBe(true);
    });

    it("says the save finished even when saving fails", async () => {
      const pendingSaves = new PendingSaves();
      const counted = providerWith({ pendingSaves });
      await storeTokens("at-0", "rt-0");
      await refreshThrough(counted);
      vi.spyOn(store, "setIf").mockRejectedValue(new Error("Credential store setIf exceeded 300ms waiting for the lock"));

      await expect(counted.saveTokens(TOKENS)).rejects.toThrow("exceeded");

      expect(await settledWithin(pendingSaves.settled(), 1_000)).toBe(true);
    });
  });

  describe("once retired", () => {
    it("drops tokens that didn't come from one of its refreshes", async () => {
      retirement.abort();

      await provider.saveTokens(TOKENS);

      expect(await store.get(oauthCredentialKey("srv"))).toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith(DROPPED, { component: "oauth" });
    });

    it("still saves a refresh it started over the tokens it refreshed, which the server won't accept again", async () => {
      await storeTokens("at-0", "rt-0");
      await refreshThrough(provider);
      retirement.abort();

      await provider.saveTokens(TOKENS);

      expect(await store.get(oauthCredentialKey("srv"))).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
    });

    it("doesn't restore a refresh's tokens where they were removed", async () => {
      await storeTokens("at-0", "rt-0");
      await refreshThrough(provider);
      await store.delete(oauthCredentialKey("srv"));
      retirement.abort();

      await provider.saveTokens(TOKENS);

      expect(await store.get(oauthCredentialKey("srv"))).toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith(DROPPED, { component: "oauth" });
    });

    it("offers no tokens and changes nothing stored", async () => {
      await storeTokens("at-0", "rt-0");
      await store.set(clientIssuerKey("srv"), { type: "secret", value: JSON.stringify({ client_id: "ci", issuer: "https://as.example" }) });
      retirement.abort();

      expect(await provider.tokens()).toBeUndefined();
      await provider.invalidateCredentials("all");
      await provider.clientInformation({ issuer: "https://as.example" });

      expect(await store.get(oauthCredentialKey("srv"))).toMatchObject({ refresh_token: "rt-0" });
      expect(await store.get(clientIssuerKey("srv"))).toBeDefined();
    });

    it("doesn't record a new authorization server binding", async () => {
      retirement.abort();

      await provider.clientInformation({ issuer: "https://as.example" });

      expect(await store.get(clientIssuerKey("srv"))).toBeUndefined();
      expect(await store.get(clientInfoKey("srv"))).toBeUndefined();
    });

    it("doesn't stamp a registered client", async () => {
      const registering = providerWith({ clientId: undefined, retirement: retirement.signal });
      const registered = { client_id: "dyn", redirect_uris: ["http://127.0.0.1/callback"] };
      await store.set(clientInfoKey("srv"), { type: "secret", value: JSON.stringify(registered) });
      retirement.abort();

      await registering.saveClientInformation({ ...registered, issuer: "https://as.example" });

      expect(await store.get(clientInfoKey("srv"))).toEqual({ type: "secret", value: JSON.stringify(registered) });
    });

    it("doesn't discard stored client information it can't read", async () => {
      const registering = providerWith({ clientId: undefined, retirement: retirement.signal });
      await store.set(clientInfoKey("srv"), { type: "secret", value: "not json" });
      retirement.abort();

      await expect(registering.clientInformation()).rejects.toThrow();

      expect(await store.get(clientInfoKey("srv"))).toEqual({ type: "secret", value: "not json" });
    });
  });
});
