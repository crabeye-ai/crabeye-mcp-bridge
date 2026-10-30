import type { BridgeConfig, ServerConfig, StdioServerConfig } from "../config/schema.js";
import { isDaemonHosted, isStdioServer } from "../config/schema.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import { resolveCredentialTemplates } from "../credentials/resolve-templates.js";
import type { Logger } from "../logging/index.js";
import { DaemonStdioClient } from "./daemon-stdio-client.js";
import { HttpUpstreamClient } from "./http-client.js";
import type { UpstreamLink } from "./instance-link.js";
import { InstanceUpstreamClient } from "./instance-upstream-client.js";
import { resolveReconnectInputs } from "./upstream-hash.js";
import type { UpstreamClient } from "./types.js";

export type UpstreamClientFactory = (
  name: string,
  config: ServerConfig,
  resolvedEnv: Record<string, string>,
  logger: Logger,
) => UpstreamClient;

export interface DefaultClientFactoryDeps {
  /** The config in force when the client is created. */
  bridgeConfig: () => BridgeConfig;
  credentialStore?: CredentialStore;
  instanceLink?: UpstreamLink;
}

/**
 * A stand-in for HTTP and SSE upstreams the daemon connects, a daemon
 * session for STDIO upstreams, and a direct connection for HTTP upstreams
 * with `_bridge.auth`.
 */
export function defaultClientFactory(deps: DefaultClientFactoryDeps): UpstreamClientFactory {
  return (name, config, _resolvedEnv, logger) => {
    if (isDaemonHosted(config)) {
      if (deps.instanceLink === undefined) throw new Error("no daemon instance link to connect this upstream through");
      return new InstanceUpstreamClient({ name, link: deps.instanceLink });
    }
    const bridgeConfig = deps.bridgeConfig();
    const reconnect = resolveReconnectInputs(bridgeConfig._bridge, config);
    if (isStdioServer(config)) {
      const daemon = bridgeConfig._bridge.daemon;
      return new DaemonStdioClient({
        name,
        config,
        logger,
        resolveEnv: () => resolveStdioEnv(config, deps.credentialStore),
        rpcTimeoutMs: daemon.rpcTimeoutMs,
        heartbeatMs: daemon.heartbeatMs,
        respawnLockWaitMs: daemon.respawnLockWaitMs,
        ...reconnect,
      });
    }
    return new HttpUpstreamClient({
      name,
      config,
      logger,
      credentialStore: deps.credentialStore,
      ...reconnect,
    });
  };
}

/** A STDIO server's `env` with `${credential:...}` templates resolved. */
export async function resolveStdioEnv(config: StdioServerConfig, store: CredentialStore | undefined): Promise<Record<string, string>> {
  const env = (config.env ?? {}) as Record<string, string>;
  if (!store) return env;
  return resolveCredentialTemplates(env, store);
}
