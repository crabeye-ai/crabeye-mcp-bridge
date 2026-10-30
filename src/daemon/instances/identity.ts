import { createHash } from "node:crypto";
import type { HttpServerConfig } from "../../config/schema.js";
import { MASTER_KEY_ENV } from "../../credentials/keychain.js";
import { clientSecretEnvName } from "../../oauth/client-secret.js";
import { canonicalize } from "../../upstream/upstream-hash.js";
import { credentialEnv, networkSettings, type NetworkSettings } from "../instance-env.js";
import type { InstanceSource } from "../protocol.js";

/** Bridges that would load the same config with the same credentials and network settings share one instance. */
export function instanceKey(source: InstanceSource, env: Record<string, string>): string {
  return digest({ kind: source.kind, path: source.path, credentials: credentialEnv(env), network: networkSettings(env) });
}

export interface HttpUpstreamIdentity {
  /** Upstreams with the same key share one connection across the daemon. */
  key: string;
  /** How that connection is made. */
  network: NetworkSettings;
  /** The client's variables that connection reads, each of them part of `key`. */
  env: Record<string, string>;
}

/**
 * Headers are compared as configured: within one daemon, the same templates
 * and master key resolve to the same values. The network settings count,
 * since they decide how the connection is made, and so does the value of the
 * variable `_bridge.auth.clientSecret` names; timing settings don't.
 */
export function httpUpstreamIdentity(name: string, config: HttpServerConfig, env: Record<string, string>): HttpUpstreamIdentity {
  const network = networkSettings(env);
  const secretName = clientSecretEnvName(config._bridge?.auth?.clientSecret);
  const clientSecretEnv = secretName !== undefined && env[secretName] !== undefined ? { [secretName]: env[secretName] } : {};
  const key = digest({
    name,
    transport: config.type === "sse" ? "sse" : "streamable-http",
    url: config.url,
    headers: config.headers ?? {},
    auth: config._bridge?.auth ?? null,
    masterKey: env[MASTER_KEY_ENV] ?? null,
    clientSecretEnv,
    network,
  });
  return { key, network, env: clientSecretEnv };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}
