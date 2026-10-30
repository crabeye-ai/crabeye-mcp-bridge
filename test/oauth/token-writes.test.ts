import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OAuth2Credential } from "../../src/credentials/types.js";
import { TokenWrites } from "../../src/oauth/token-writes.js";
import { makeTestStore, type TestStoreHandle } from "../_helpers/credential-store.js";

const KEY = "oauth:svc";
const tokens = (access: string, refresh: string, issuer?: string): OAuth2Credential => ({
  type: "oauth2",
  access_token: access,
  refresh_token: refresh,
  ...(issuer !== undefined && { issuer }),
});

describe("TokenWrites", () => {
  let handle: TestStoreHandle;
  let writes: TokenWrites;

  beforeEach(() => {
    handle = makeTestStore("token-writes-");
    writes = new TokenWrites({ store: handle.store, serverName: "svc" });
  });

  afterEach(() => {
    handle.cleanup();
  });

  const stored = () => handle.store.get(KEY);

  it("saves a refresh's tokens over the tokens it refreshed", async () => {
    await handle.store.set(KEY, tokens("at-0", "rt-0"));

    expect(await writes.write(tokens("at-1", "rt-1"), { redeemed: "rt-0", addIfMissing: true })).toBe(true);

    expect(await stored()).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
  });

  it("drops a refresh's tokens when other tokens were stored since, such as by auth", async () => {
    await handle.store.set(KEY, tokens("at-auth", "rt-auth"));

    expect(await writes.write(tokens("at-1", "rt-1"), { redeemed: "rt-0", addIfMissing: true })).toBe(false);

    expect(await stored()).toMatchObject({ access_token: "at-auth", refresh_token: "rt-auth" });
  });

  it("saves a refresh's tokens again over the same tokens, saved by another connection that shared the refresh", async () => {
    await handle.store.set(KEY, tokens("at-1", "rt-1"));

    expect(await writes.write(tokens("at-1", "rt-1", "https://as.example"), { redeemed: "rt-0", addIfMissing: true })).toBe(true);

    expect(await stored()).toMatchObject({ issuer: "https://as.example" });
  });

  it("restores a refresh's tokens where they are missing, as after a process whose refresh was refused deleted them", async () => {
    expect(await writes.write(tokens("at-1", "rt-1"), { redeemed: "rt-0", addIfMissing: true })).toBe(true);

    expect(await stored()).toMatchObject({ access_token: "at-1", refresh_token: "rt-1" });
  });

  it("stores tokens that didn't come from a refresh it saw over whatever is stored", async () => {
    await handle.store.set(KEY, tokens("at-other", "rt-other"));

    expect(await writes.write(tokens("at-1", "rt-1"), { redeemed: undefined, addIfMissing: true })).toBe(true);

    expect(await stored()).toMatchObject({ access_token: "at-1" });
  });

  describe("without adding where tokens are missing, as for a retired provider", () => {
    it("still saves a refresh's tokens over the very tokens it refreshed, which the server no longer accepts", async () => {
      await handle.store.set(KEY, tokens("at-0", "rt-0"));

      expect(await writes.write(tokens("at-1", "rt-1"), { redeemed: "rt-0", addIfMissing: false })).toBe(true);

      expect(await stored()).toMatchObject({ refresh_token: "rt-1" });
    });

    it("doesn't restore tokens that are missing, as after auth --remove", async () => {
      expect(await writes.write(tokens("at-1", "rt-1"), { redeemed: "rt-0", addIfMissing: false })).toBe(false);

      expect(await stored()).toBeUndefined();
    });
  });

  it("stamps an issuer on tokens it read only while those tokens are still stored", async () => {
    writes.rememberRead({ access_token: "at-0", refresh_token: "rt-0" });
    await handle.store.set(KEY, tokens("at-new", "rt-new"));

    await writes.write(tokens("at-0", "rt-0", "https://as.example"), { redeemed: undefined, addIfMissing: true });

    expect(await stored()).toMatchObject({ access_token: "at-new" });
    expect(await stored()).not.toHaveProperty("issuer");
  });
});
