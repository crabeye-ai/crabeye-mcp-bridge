import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "../../src/credentials/credential-store.js";
import { EnvKeychain } from "../../src/credentials/keychain.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { awaitHeld, exited, killAll, startLineProcess } from "../_helpers/processes.js";
import { startRotatingAuthServer, type RotatingAuthServer } from "../_helpers/rotating-auth-server.js";
import { NEEDS_AUTH, raceTwoRefreshes, seedTokens, storedRefreshToken } from "../_helpers/refresh-race.js";

const MASTER_KEY = randomBytes(32).toString("hex");
const RACE_TIMEOUT_MS = 20_000;
const CHILD_LOCK_TIMEOUT_MS = 5_000;

describe("two processes racing on a rotating refresh token (#224)", { timeout: 60_000 }, () => {
  let refresherScript: string;
  let lockScript: string;
  let dir: string;
  let storePath: string;
  let authServer: RotatingAuthServer;
  const children: ChildProcessWithoutNullStreams[] = [];

  beforeAll(async () => {
    [refresherScript, lockScript] = await Promise.all([
      bundleForSubprocess("test/_helpers/subprocess/oauth-refresher.ts", "oauth-refresher"),
      bundleForSubprocess("test/_helpers/subprocess/acquire-lock.ts", "acquire-lock"),
    ]);
  });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-rotating-procs-"));
    storePath = join(dir, "credentials.enc");
    authServer = await startRotatingAuthServer("rt-1");
    await seedTokens(store(), authServer, "rt-1");
  });

  afterEach(async () => {
    await killAll(children);
    await authServer.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  const store = () => new CredentialStore({ keychain: new EnvKeychain(MASTER_KEY), filePath: storePath });
  const start = (script: string, args: string[]) =>
    startLineProcess(children, script, args, { ...process.env, MCP_BRIDGE_MASTER_KEY: MASTER_KEY, HOME: dir, USERPROFILE: dir });

  const refresh = () => {
    const { line } = start(refresherScript, [storePath, authServer.resourceUrl, String(CHILD_LOCK_TIMEOUT_MS)]);
    return line().then((text) => JSON.parse(text) as { result?: string; error?: string });
  };

  it("keeps the winner's tokens when the loser's rejection is handled after the winner saved, and the loser then succeeds without auth", async () => {
    const { winner, loser, rotation, rejection } = await raceTwoRefreshes(authServer, refresh, refresh, RACE_TIMEOUT_MS);

    rotation.release();
    expect(await winner).toEqual({ result: "AUTHORIZED" });
    expect(await storedRefreshToken(store())).toBe("rt-1-rotated-1");
    rejection.release();

    expect(await loser).toEqual({ result: "AUTHORIZED" });
    expect(await storedRefreshToken(store())).toBe(authServer.currentRefreshToken());
  });

  it("keeps the winner's save when the loser's rejection is handled first, and the loser's next attempt succeeds without auth", async () => {
    const { winner, loser, rotation, rejection } = await raceTwoRefreshes(authServer, refresh, refresh, RACE_TIMEOUT_MS);

    rejection.release();
    expect(await loser).toEqual({ error: expect.stringContaining(NEEDS_AUTH) });
    rotation.release();
    expect(await winner).toEqual({ result: "AUTHORIZED" });
    expect(await storedRefreshToken(store())).toBe("rt-1-rotated-1");

    expect(await refresh()).toEqual({ result: "AUTHORIZED" });
  });

  it("takes over a lock a killed process left between the winner's save and the loser's check", async () => {
    const { winner, loser, rotation, rejection } = await raceTwoRefreshes(authServer, refresh, refresh, RACE_TIMEOUT_MS);
    rotation.release();
    expect(await winner).toEqual({ result: "AUTHORIZED" });
    const holder = await awaitHeld(start(lockScript, [`${storePath}.lock`]));
    holder.child.kill("SIGKILL");
    await exited(holder.child, 5_000);
    expect(existsSync(`${storePath}.lock`)).toBe(true);

    rejection.release();

    expect(await loser).toEqual({ result: "AUTHORIZED" });
    expect(await storedRefreshToken(store())).toBe(authServer.currentRefreshToken());
  });
});
