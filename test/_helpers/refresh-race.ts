import type { CredentialStore } from "../../src/credentials/credential-store.js";
import { BridgeOAuthClientProvider } from "../../src/oauth/sdk-provider.js";
import { oauthCredentialKey } from "../../src/oauth/index.js";
import { until } from "./daemon-fixtures.js";
import type { HeldTokenResponse, RotatingAuthServer } from "./rotating-auth-server.js";

export const RACED_SERVER = "srv";
export const RACED_KEY = oauthCredentialKey(RACED_SERVER);
export const NEEDS_AUTH = `Run: crabeye-mcp-bridge auth ${RACED_SERVER}`;

export function runtimeProvider(store: CredentialStore): BridgeOAuthClientProvider {
  return new BridgeOAuthClientProvider({
    serverName: RACED_SERVER,
    store,
    redirectUrl: "http://127.0.0.1/callback",
    clientId: "client-1",
    runtime: true,
  });
}

export function seedTokens(
  store: CredentialStore,
  authServer: RotatingAuthServer,
  refreshToken: string,
  { stamped = true }: { stamped?: boolean } = {},
): Promise<void> {
  return store.set(RACED_KEY, {
    type: "oauth2",
    access_token: "at-0",
    token_type: "Bearer",
    refresh_token: refreshToken,
    ...(stamped && { issuer: authServer.issuer }),
  });
}

export async function storedRefreshToken(store: CredentialStore): Promise<string | undefined> {
  const stored = await store.get(RACED_KEY);
  return stored?.type === "oauth2" ? stored.refresh_token : undefined;
}

export interface RefreshRace<W, L = W> {
  winner: Promise<W>;
  loser: Promise<L>;
  rotation: HeldTokenResponse;
  rejection: HeldTokenResponse;
}

export async function raceTwoRefreshes<W, L = W>(
  authServer: RotatingAuthServer,
  first: () => Promise<W>,
  second: () => Promise<L>,
  timeoutMs = 5_000,
): Promise<RefreshRace<W, L>> {
  authServer.holdResponses(true);
  const winner = first();
  await until(() => authServer.held().length === 1, timeoutMs);
  const loser = second();
  await until(() => authServer.held().length === 2, timeoutMs);
  authServer.holdResponses(false);
  const [rotation, rejection] = authServer.held();
  if (rotation.outcome !== "rotated" || rejection.outcome !== "rejected") {
    throw new Error(`expected a rotation then a rejection, got ${rotation.outcome} then ${rejection.outcome}`);
  }
  return { winner, loser, rotation, rejection };
}
