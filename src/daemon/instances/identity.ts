import { createHash } from "node:crypto";
import type { HttpServerConfig } from "../../config/schema.js";
import { MASTER_KEY_ENV } from "../../credentials/keychain.js";
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
}

/**
 * Headers are compared as configured: within one daemon, the same templates
 * and master key resolve to the same values. The network settings count,
 * since they decide how the connection is made; timing settings don't.
 */
export function httpUpstreamIdentity(name: string, config: HttpServerConfig, env: Record<string, string>): HttpUpstreamIdentity {
  const network = networkSettings(env);
  const key = digest({
    name,
    transport: config.type === "sse" ? "sse" : "streamable-http",
    url: config.url,
    headers: config.headers ?? {},
    auth: config._bridge?.auth ?? null,
    masterKey: env[MASTER_KEY_ENV] ?? null,
    network,
  });
  return { key, network };
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}
