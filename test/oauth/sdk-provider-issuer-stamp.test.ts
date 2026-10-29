import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeOAuthClientProvider } from "../../src/oauth/sdk-provider.js";
import { oauthCredentialKey } from "../../src/oauth/index.js";
import { makeTestStore, oauthTokens, type TestStoreHandle } from "../_helpers/credential-store.js";

const KEY = oauthCredentialKey("srv");
const ISSUER = "https://as.example";

describe("stamping the issuer on stored tokens (#224)", () => {
  let handle: TestStoreHandle;

  beforeEach(() => {
    handle = makeTestStore("issuer-stamp-");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    handle.cleanup();
  });

  function provider(): BridgeOAuthClientProvider {
    return new BridgeOAuthClientProvider({ serverName: "srv", store: handle.store, redirectUrl: "http://127.0.0.1/callback", runtime: true });
  }

  async function refreshRejected(p: BridgeOAuthClientProvider, refreshToken: string): Promise<void> {
    const rejecting = p.wrapFetch(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    await rejecting("https://as.example/token", {
      method: "POST",
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
  }

  it("adds the issuer to the tokens it read", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    const read = await p.tokens();

    await p.saveTokens({ ...read!, issuer: ISSUER });

    expect(await handle.store.get(KEY)).toMatchObject({ refresh_token: "rt-1", issuer: ISSUER });
  });

  it("doesn't write the tokens it read back over newer ones another process saved meanwhile", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    const read = await p.tokens();
    await handle.store.set(KEY, oauthTokens("rt-2"));

    await p.saveTokens({ ...read!, issuer: ISSUER });

    expect(await handle.store.get(KEY)).toEqual(oauthTokens("rt-2"));
  });

  it("doesn't write the access token it read back over a newer one saved meanwhile with the same refresh token", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    const read = await p.tokens();
    await handle.store.set(KEY, { ...oauthTokens("rt-1"), access_token: "at-newer" });

    await p.saveTokens({ ...read!, issuer: ISSUER });

    expect(await handle.store.get(KEY)).toMatchObject({ access_token: "at-newer", refresh_token: "rt-1" });
  });

  it("doesn't write the refresh token it read back over a rotated one saved meanwhile with the same access token", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    const read = await p.tokens();
    await handle.store.set(KEY, { ...oauthTokens("rt-2"), access_token: "at-rt-1" });

    await p.saveTokens({ ...read!, issuer: ISSUER });

    expect(await handle.store.get(KEY)).toMatchObject({ refresh_token: "rt-2" });
  });

  it("adds the issuer to the latest of several reads", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await p.tokens();
    await handle.store.set(KEY, oauthTokens("rt-2"));
    const later = await p.tokens();

    await p.saveTokens({ ...later!, issuer: ISSUER });

    expect(await handle.store.get(KEY)).toMatchObject({ refresh_token: "rt-2", issuer: ISSUER });
  });

  it("doesn't write back an earlier read over newer tokens a later read saw", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    const earlier = await p.tokens();
    await handle.store.set(KEY, oauthTokens("rt-2"));
    await p.tokens();

    await p.saveTokens({ ...earlier!, issuer: ISSUER });

    expect(await handle.store.get(KEY)).toEqual(oauthTokens("rt-2"));
  });

  it("remembers only the most recent reads", async () => {
    const p = provider();
    await handle.store.set(KEY, oauthTokens("rt-oldest"));
    const oldest = await p.tokens();
    for (let i = 0; i < 16; i++) {
      await handle.store.set(KEY, oauthTokens(`rt-${i}`));
      await p.tokens();
    }

    await p.saveTokens({ ...oldest!, issuer: ISSUER });

    expect(await handle.store.get(KEY)).toMatchObject({ refresh_token: "rt-oldest", issuer: ISSUER });
  });

  it("doesn't replace an issuer another process stamped with a different one", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    const read = await p.tokens();
    await handle.store.set(KEY, { ...oauthTokens("rt-1"), issuer: "https://other.example" });

    await p.saveTokens({ ...read!, issuer: ISSUER });

    expect(await handle.store.get(KEY)).toMatchObject({ issuer: "https://other.example" });
  });

  it("doesn't drop an issuer another process stamped when writing back without one", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    const read = await p.tokens();
    await handle.store.set(KEY, { ...oauthTokens("rt-1"), issuer: ISSUER });

    await p.saveTokens(read!);

    expect(await handle.store.get(KEY)).toMatchObject({ issuer: ISSUER });
  });

  it("doesn't write back stamped tokens it read over newer ones another process saved", async () => {
    await handle.store.set(KEY, { ...oauthTokens("rt-1"), issuer: ISSUER });
    const p = provider();
    const read = await p.tokens();
    await handle.store.set(KEY, { ...oauthTokens("rt-2"), issuer: ISSUER });

    await p.saveTokens(read!);

    expect(await handle.store.get(KEY)).toMatchObject({ refresh_token: "rt-2" });
  });

  it("doesn't bring back tokens that were deleted meanwhile", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    const read = await p.tokens();
    await handle.store.delete(KEY);

    await p.saveTokens({ ...read!, issuer: ISSUER });

    expect(await handle.store.get(KEY)).toBeUndefined();
  });

  it("doesn't write back a read that overlapped an invalidation which kept another process's tokens", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshRejected(p, "rt-1");
    const before = await handle.store.get(KEY);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(handle.store, "get").mockImplementationOnce(async () => {
      await held;
      return before;
    });
    const reading = p.tokens();
    await handle.store.set(KEY, { ...oauthTokens("rt-2"), issuer: ISSUER });
    await p.invalidateCredentials("tokens");
    release();
    const read = await reading;

    await p.saveTokens({ ...read!, issuer: ISSUER });

    expect(await handle.store.get(KEY)).toMatchObject({ refresh_token: "rt-2" });
  });

  it("doesn't write back a read made before an invalidation which kept another process's tokens", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await refreshRejected(p, "rt-1");
    const read = await p.tokens();
    await handle.store.set(KEY, { ...oauthTokens("rt-2"), issuer: ISSUER });
    await p.invalidateCredentials("tokens");

    await p.saveTokens({ ...read!, issuer: ISSUER });

    expect(await handle.store.get(KEY)).toMatchObject({ refresh_token: "rt-2" });
  });

  it("always writes tokens a refresh just issued", async () => {
    await handle.store.set(KEY, oauthTokens("rt-1"));
    const p = provider();
    await p.tokens();
    await handle.store.set(KEY, oauthTokens("rt-2"));

    await p.saveTokens({ access_token: "at-new", token_type: "Bearer", refresh_token: "rt-new" });

    expect(await handle.store.get(KEY)).toMatchObject({ access_token: "at-new", refresh_token: "rt-new" });
  });
});
