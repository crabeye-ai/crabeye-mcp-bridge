import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth } from "@modelcontextprotocol/client";
import { BridgeConfigSchema } from "../../src/config/schema.js";
import { runAuthLogin } from "../../src/commands/auth.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { makeTestStore, type TestStoreHandle } from "../_helpers/credential-store.js";
import { startRotatingAuthServer, type RotatingAuthServer } from "../_helpers/rotating-auth-server.js";
import { RACED_SERVER, raceTwoRefreshes, runtimeProvider, seedTokens, storedRefreshToken } from "../_helpers/refresh-race.js";

describe("crabeye auth racing a bridge on a rotating refresh token (#224)", { timeout: 20_000 }, () => {
  let handle: TestStoreHandle;
  let authServer: RotatingAuthServer;
  let aborted: AbortController;
  let browserOpened: boolean;
  let printed: string[];

  beforeEach(async () => {
    handle = makeTestStore("auth-rotating-");
    authServer = await startRotatingAuthServer("rt-1");
    await seedTokens(handle.store, authServer, "rt-1");
    aborted = new AbortController();
    browserOpened = false;
    printed = [];
  });

  afterEach(async () => {
    await authServer.close();
    handle.cleanup();
  });

  function bridgeRefresh(): Promise<string> {
    const bridge = runtimeProvider(handle.store);
    return auth(bridge, { serverUrl: authServer.resourceUrl, fetchFn: bridge.wrapFetch(fetch) });
  }

  function cliLogin(): Promise<number> {
    return runAuthLogin(
      { serverName: RACED_SERVER },
      {
        store: handle.store,
        print: (line) => printed.push(line),
        errPrint: () => {},
        signal: aborted.signal,
        loadConfig: async () =>
          BridgeConfigSchema.parse({
            mcpServers: {
              [RACED_SERVER]: { type: "streamable-http", url: authServer.resourceUrl, _bridge: { auth: { type: "oauth2", clientId: "client-1" } } },
            },
          }),
        openBrowser: async () => {
          browserOpened = true;
          aborted.abort();
          return true;
        },
      },
    );
  }

  it("keeps the bridge's new tokens and reports already authenticated without opening a browser", async () => {
    const { winner, loser, rotation, rejection } = await raceTwoRefreshes(authServer, bridgeRefresh, cliLogin);

    rotation.release();
    expect(await winner).toBe("AUTHORIZED");
    rejection.release();

    expect(await loser).toBe(0);
    expect(browserOpened).toBe(false);
    expect(printed).toContain(`Already authenticated as "${RACED_SERVER}"`);
    expect(await storedRefreshToken(handle.store)).toBe(authServer.currentRefreshToken());
  });

  it("keeps the bridge's new tokens when the CLI's rejection is handled first and it opens a browser", async () => {
    const { winner, loser, rotation, rejection } = await raceTwoRefreshes(authServer, bridgeRefresh, cliLogin);

    rejection.release();
    await until(() => browserOpened);
    rotation.release();
    expect(await winner).toBe("AUTHORIZED");

    expect(await loser).toBe(1);
    expect(await storedRefreshToken(handle.store)).toBe("rt-1-rotated-1");
  });
});
