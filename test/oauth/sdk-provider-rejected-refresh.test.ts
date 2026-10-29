import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { CredentialError } from "../../src/credentials/errors.js";
import { BridgeOAuthClientProvider } from "../../src/oauth/sdk-provider.js";
import { oauthCredentialKey } from "../../src/oauth/index.js";
import { refreshRequestOf } from "../../src/oauth/refresh-request.js";
import { makeTestStore, oauthTokens, secret, type TestStoreHandle } from "../_helpers/credential-store.js";
import { spyLogger, type SpyLogger } from "../_helpers/spy-logger.js";

const KEY = oauthCredentialKey("srv");
const TOKEN_ENDPOINT = "https://as.example/token";
const SAVES_THAT_TRIP_THE_BREAKER = 7;

function refreshRequest(refreshToken: string): RequestInit {
  return { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }) };
}

const tokenError = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

const tokensIssued = (refreshToken: string) =>
  new Response(JSON.stringify({ access_token: `at-${refreshToken}`, token_type: "Bearer", refresh_token: refreshToken }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe("invalidating tokens after a rejected refresh (#224)", () => {
  let handle: TestStoreHandle;
  let logger: SpyLogger;

  beforeEach(() => {
    handle = makeTestStore("rejected-refresh-");
    logger = spyLogger();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    handle.cleanup();
  });

  function provider(): BridgeOAuthClientProvider {
    return new BridgeOAuthClientProvider({ serverName: "srv", store: handle.store, redirectUrl: "http://127.0.0.1/callback", runtime: true, logger });
  }

  async function refreshAnswered(p: BridgeOAuthClientProvider, refreshToken: string, answer: () => Promise<Response>): Promise<void> {
    await p.wrapFetch(answer)(TOKEN_ENDPOINT, refreshRequest(refreshToken)).catch(() => {});
  }

  const refreshRejected = (p: BridgeOAuthClientProvider, refreshToken: string) =>
    refreshAnswered(p, refreshToken, async () => tokenError(400, "invalid_grant"));

  async function tripTheBreaker(p: BridgeOAuthClientProvider): Promise<void> {
    for (let i = 0; i < SAVES_THAT_TRIP_THE_BREAKER; i++) {
      await p.saveTokens({ access_token: `at-${i}`, token_type: "Bearer", refresh_token: `rt-loop-${i}` });
    }
  }

  it("deletes the tokens when the store still holds the refresh token that was rejected", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshRejected(p, "rt-1");

    await p.invalidateCredentials("tokens");

    expect(await handle.store.get(KEY)).toBeUndefined();
  });

  it("keeps the tokens another process saved after the rejected refresh read them, and hands them to the next request", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshRejected(p, "rt-1");
    await handle.store.set(KEY, oauthTokens("rt-2"));

    await p.invalidateCredentials("tokens");

    expect(await handle.store.get(KEY)).toEqual(oauthTokens("rt-2"));
    expect(await p.tokens()).toMatchObject({ access_token: "at-rt-2", refresh_token: "rt-2" });
    expect(logger.info).toHaveBeenCalledWith('kept the tokens for "srv" that were refreshed elsewhere', { component: "oauth" });
  });

  it("keeps them too when the client was rejected rather than the grant", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshAnswered(p, "rt-1", async () => tokenError(401, "invalid_client"));
    await handle.store.set(KEY, oauthTokens("rt-2"));

    await p.invalidateCredentials("client");
    await p.invalidateCredentials("tokens");

    expect(await handle.store.get(KEY)).toEqual(oauthTokens("rt-2"));
  });

  it("keeps OAuth tokens without a refresh token that another process saved", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshRejected(p, "rt-1");
    await handle.store.set(KEY, { type: "oauth2", access_token: "at-reauthorized" });

    await p.invalidateCredentials("tokens");

    expect(await handle.store.get(KEY)).toEqual({ type: "oauth2", access_token: "at-reauthorized" });
  });

  it("deletes an entry that doesn't hold OAuth tokens", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshRejected(p, "rt-1");
    await handle.store.set(KEY, secret("not tokens"));

    await p.invalidateCredentials("tokens");

    expect(await handle.store.get(KEY)).toBeUndefined();
  });

  it("does nothing, without an error, when the tokens are already gone", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshRejected(p, "rt-1");
    await handle.store.delete(KEY);

    await expect(p.invalidateCredentials("tokens")).resolves.toBeUndefined();
    expect(await handle.store.get(KEY)).toBeUndefined();
  });

  it("deletes whatever is stored when no refresh was rejected", async () => {
    await handle.store.set(KEY, oauthTokens("rt-2"));

    await provider().invalidateCredentials("tokens");

    expect(await handle.store.get(KEY)).toBeUndefined();
  });

  it("doesn't count a refresh that succeeded as rejected", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshAnswered(p, "rt-1", async () => tokensIssued("rt-2"));
    await handle.store.set(KEY, oauthTokens("rt-3"));

    await p.invalidateCredentials("tokens");

    expect(await handle.store.get(KEY)).toBeUndefined();
  });

  it.each<[string, () => Promise<Response>]>([
    ["408", async () => tokenError(408, "timeout")],
    ["429", async () => tokenError(429, "slow_down")],
    ["500", async () => tokenError(500, "server_error")],
    ["503", async () => tokenError(503, "temporarily_unavailable")],
    [
      "a network error",
      async () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("doesn't count a refresh that failed with %s as rejected", async (_label, answer) => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshAnswered(p, "rt-1", answer);
    await refreshRejected(p, "rt-unrelated");

    await p.invalidateCredentials("tokens");

    expect(await handle.store.get(KEY)).toEqual(oauthTokens("rt-1"));
  });

  it("remembers the token the request carried, not a different one a caller joining in sent", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    const rejection = gate();
    const sent: (string | undefined)[] = [];
    const wrapped = p.wrapFetch(async (_input, init) => {
      const refreshToken = refreshRequestOf(init)?.refreshToken;
      sent.push(refreshToken);
      if (refreshToken !== "rt-1") return tokensIssued("rt-3");
      await rejection.opened;
      return tokenError(400, "invalid_grant");
    });
    const first = wrapped(TOKEN_ENDPOINT, refreshRequest("rt-1"));
    await handle.store.set(KEY, oauthTokens("rt-2"));
    const second = wrapped(TOKEN_ENDPOINT, refreshRequest("rt-2"));
    rejection.open();
    await Promise.all([first, second]);

    await p.invalidateCredentials("tokens");

    expect(sent).toEqual(["rt-1", "rt-2"]);
    expect(await handle.store.get(KEY)).toEqual(oauthTokens("rt-2"));
  });

  it("still coalesces callers refreshing the same token into one request", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    const rejection = gate();
    const base = vi.fn(async () => {
      await rejection.opened;
      return tokenError(400, "invalid_grant");
    });
    const wrapped = p.wrapFetch(base);
    const callers = [wrapped(TOKEN_ENDPOINT, refreshRequest("rt-1")), wrapped(TOKEN_ENDPOINT, refreshRequest("rt-1"))];
    rejection.open();
    await Promise.all(callers);
    await handle.store.set(KEY, oauthTokens("rt-2"));

    await Promise.all([p.invalidateCredentials("tokens"), p.invalidateCredentials("tokens")]);

    expect(base).toHaveBeenCalledTimes(1);
    expect(await handle.store.get(KEY)).toEqual(oauthTokens("rt-2"));
  });

  it("keeps the rejection in mind after a later successful save, so a late caller still checks", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshRejected(p, "rt-1");
    await handle.store.set(KEY, oauthTokens("rt-2"));
    await p.tokens();
    await p.saveTokens({ access_token: "at-rt-3", token_type: "Bearer", refresh_token: "rt-3" });

    await p.invalidateCredentials("tokens");

    expect(await handle.store.get(KEY)).toMatchObject({ refresh_token: "rt-3" });
  });

  it("deletes everything on an explicit 'all', whatever was rejected", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshRejected(p, "rt-1");
    await handle.store.set(KEY, oauthTokens("rt-2"));

    await p.invalidateCredentials("all");

    expect(await handle.store.get(KEY)).toBeUndefined();
  });

  it("leaves a tripped refresh circuit breaker tripped when it keeps the tokens", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await tripTheBreaker(p);
    expect(await p.tokens()).toBeUndefined();
    await refreshRejected(p, "rt-1");

    await p.invalidateCredentials("tokens");

    expect(await handle.store.get(KEY)).toMatchObject({ refresh_token: `rt-loop-${SAVES_THAT_TRIP_THE_BREAKER - 1}` });
    expect(await p.tokens()).toBeUndefined();
  });

  it("resets a tripped refresh circuit breaker when it deletes the tokens", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await tripTheBreaker(p);
    await refreshRejected(p, `rt-loop-${SAVES_THAT_TRIP_THE_BREAKER - 1}`);

    await p.invalidateCredentials("tokens");
    await handle.store.set(KEY, oauthTokens("rt-new"));

    expect(await p.tokens()).toMatchObject({ refresh_token: "rt-new" });
  });

  it("resets a tripped refresh circuit breaker when the tokens were already gone", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await tripTheBreaker(p);
    await refreshRejected(p, `rt-loop-${SAVES_THAT_TRIP_THE_BREAKER - 1}`);
    await handle.store.delete(KEY);

    await p.invalidateCredentials("tokens");
    await handle.store.set(KEY, oauthTokens("rt-new"));

    expect(await p.tokens()).toMatchObject({ refresh_token: "rt-new" });
  });

  it("keeps the tokens and logs why when the store's lock can't be taken", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const timeout = new CredentialError("Credential store deleteIf exceeded 300ms waiting for the lock");
    vi.spyOn(handle.store, "deleteIf").mockRejectedValue(timeout);
    const p = provider();
    await refreshRejected(p, "rt-1");

    await expect(p.invalidateCredentials("tokens")).rejects.toBe(timeout);

    expect(await handle.store.get(KEY)).toEqual(oauthTokens("rt-1"));
    expect(logger.warn).toHaveBeenCalledWith('could not check the stored tokens for "srv"; keeping them', {
      component: "oauth",
      error: timeout.message,
    });
  });

  it("leaves the store file alone and logs why when the store can't be read", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshRejected(p, "rt-1");
    await writeFile(handle.filePath, "not a credential store");

    await expect(p.invalidateCredentials("tokens")).rejects.toThrow(CredentialError);

    expect(await readFile(handle.filePath, "utf8")).toBe("not a credential store");
    expect(logger.warn).toHaveBeenCalledWith(
      'could not check the stored tokens for "srv"; keeping them',
      expect.objectContaining({ component: "oauth" }),
    );
  });
});
