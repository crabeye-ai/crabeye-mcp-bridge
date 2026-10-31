import type { HttpServerConfig } from "../../config/schema.js";
import type { CredentialStore } from "../../credentials/credential-store.js";
import type { Logger } from "../../logging/index.js";
import { PendingSaves } from "../../oauth/pending-saves.js";
import type { SharedRefreshes } from "../../oauth/shared-refreshes.js";
import { HttpUpstreamClient } from "../../upstream/http-client.js";
import type { UpstreamReconnectInputs } from "../../upstream/upstream-hash.js";
import type { UpstreamClient } from "../../upstream/types.js";
import type { NetworkSettings } from "../instance-env.js";
import { httpUpstreamType } from "./identity.js";
import { networkFetch } from "./network.js";
import type { ConnectionDeps, HttpPoolConnection } from "./pooled-upstream.js";

export interface HttpConnectionSpec {
  config: HttpServerConfig;
  credentialStore: CredentialStore;
  reconnect: UpstreamReconnectInputs;
  network: NetworkSettings;
  /** The client variables the connection reads, all of them part of its key. */
  env: Record<string, string>;
}

/** An HTTP connection's client, which can be told its OAuth provider must stop changing what is stored. */
export type HttpPoolClient = UpstreamClient & { retireAuth(): void };

export type CreateHttpClient = (
  name: string,
  config: HttpServerConfig,
  deps: {
    logger: Logger;
    credentialStore: CredentialStore;
    reconnect: UpstreamReconnectInputs;
    fetch: typeof fetch;
    env: Record<string, string>;
    refreshes: SharedRefreshes;
    pendingSaves: PendingSaves;
  },
) => HttpPoolClient;

export const defaultCreateHttpClient: CreateHttpClient = (name, config, deps) =>
  new HttpUpstreamClient({
    name,
    config,
    logger: deps.logger,
    credentialStore: deps.credentialStore,
    fetch: deps.fetch,
    env: deps.env,
    refreshes: deps.refreshes,
    pendingSaves: deps.pendingSaves,
    ...deps.reconnect,
  });

/**
 * An HTTP or SSE connection with its own network. Closing closes the client
 * at once, then keeps the network open until its refreshes have saved their
 * tokens, for as long as a refresh may take or until `limitSaveWait` cuts the
 * wait: the authorization server may already have redeemed the refresh token,
 * and closing the network would lose the new one. Its OAuth providers are
 * then retired, so a refresh one of them joins afterwards can't put back
 * credentials removed since.
 */
export function createHttpConnection(
  spec: HttpConnectionSpec,
  deps: ConnectionDeps & { refreshes: SharedRefreshes; createClient: CreateHttpClient },
): HttpPoolConnection {
  const pendingSaves = new PendingSaves();
  const stopWaiting = new AbortController();
  const network = networkFetch(spec.network, deps.logger);
  const client = deps.createClient(deps.name, spec.config, {
    logger: deps.logger,
    credentialStore: spec.credentialStore,
    reconnect: spec.reconnect,
    fetch: network.fetch,
    env: spec.env,
    refreshes: deps.refreshes,
    pendingSaves,
  });
  return {
    type: httpUpstreamType(spec.config),
    client,
    async close() {
      await client.close().catch(() => {});
      await pendingSaves.settled(stopWaiting.signal);
      client.retireAuth();
      await network.close();
    },
    credentialsChanged() {
      client.retireAuth();
      return client.reconnect().catch(() => {});
    },
    retireAuth: () => client.retireAuth(),
    limitSaveWait(ms) {
      setTimeout(() => stopWaiting.abort(), ms).unref();
    },
  };
}
