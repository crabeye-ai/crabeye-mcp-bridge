import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth } from "@modelcontextprotocol/client";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../../src/credentials/credential-store.js";
import { EnvKeychain } from "../../src/credentials/keychain.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { startRotatingAuthServer, type RotatingAuthServer } from "../_helpers/rotating-auth-server.js";
import { NEEDS_AUTH, RACED_KEY, raceTwoRefreshes, runtimeProvider, seedTokens, storedRefreshToken } from "../_helpers/refresh-race.js";

const MASTER_KEY = randomBytes(32).toString("hex");

describe("two refreshers in one process racing on a rotating refresh token (#224)", { timeout: 20_000 }, () => {
  let dir: string;
  let authServer: RotatingAuthServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-rotating-"));
    authServer = await startRotatingAuthServer("rt-1");
    await seedTokens(store(), authServer, "rt-1");
  });

  afterEach(async () => {
    await authServer.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  function store(): CredentialStore {
    return new CredentialStore({ keychain: new EnvKeychain(MASTER_KEY), filePath: join(dir, "credentials.enc") });
  }

  function refresh(): Promise<string> {
    const provider = runtimeProvider(store());
    return auth(provider, { serverUrl: authServer.resourceUrl, fetchFn: provider.wrapFetch(fetch) });
  }

  it("keeps the winner's tokens when the loser's rejection is handled after the winner saved, and the loser then succeeds without auth", async () => {
    const { winner, loser, rotation, rejection } = await raceTwoRefreshes(authServer, refresh, refresh);

    rotation.release();
    expect(await winner).toBe("AUTHORIZED");
    expect(await storedRefreshToken(store())).toBe("rt-1-rotated-1");
    rejection.release();

    expect(await loser).toBe("AUTHORIZED");
    expect(await storedRefreshToken(store())).toBe(authServer.currentRefreshToken());
  });

  it("keeps the winner's save when the loser's rejection is handled first, and the loser's next attempt succeeds without auth", async () => {
    const { winner, loser, rotation, rejection } = await raceTwoRefreshes(authServer, refresh, refresh);

    rejection.release();
    await expect(loser).rejects.toThrow(NEEDS_AUTH);
    rotation.release();
    expect(await winner).toBe("AUTHORIZED");
    expect(await storedRefreshToken(store())).toBe("rt-1-rotated-1");

    expect(await refresh()).toBe("AUTHORIZED");
  });

  it("reaches the same outcome when the stored tokens start without an issuer stamp", async () => {
    await seedTokens(store(), authServer, "rt-1", { stamped: false });
    const { winner, loser, rotation, rejection } = await raceTwoRefreshes(authServer, refresh, refresh);

    rotation.release();
    expect(await winner).toBe("AUTHORIZED");
    rejection.release();

    expect(await loser).toBe("AUTHORIZED");
    expect(await storedRefreshToken(store())).toBe(authServer.currentRefreshToken());
  });

  it("deletes the tokens and asks for auth when the refresh token is rejected and nobody else refreshed", async () => {
    await seedTokens(store(), authServer, "rt-stale");

    await expect(refresh()).rejects.toThrow(NEEDS_AUTH);

    expect(await store().get(RACED_KEY)).toBeUndefined();
  });

  it("asks for auth without an error of its own when the tokens vanished before the rejection was handled", async () => {
    await seedTokens(store(), authServer, "rt-stale");
    authServer.holdResponses(true);
    const loser = refresh();
    await until(() => authServer.held().length === 1);
    authServer.holdResponses(false);
    await store().delete(RACED_KEY);

    authServer.held()[0].release();

    await expect(loser).rejects.toThrow(NEEDS_AUTH);
    expect(await store().get(RACED_KEY)).toBeUndefined();
  });
});
