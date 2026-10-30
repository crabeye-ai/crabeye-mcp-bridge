import type { BridgeConfig, ServerConfig, ToolPolicy } from "./schema.js";
import { resolveUpstreams, isStdioServer } from "./schema.js";
import type { LogLevel } from "../logging/index.js";

export interface ServerDiff<T extends ServerConfig = ServerConfig> {
  added: Array<{ name: string; config: T }>;
  removed: string[];
  reconnect: Array<{ name: string; config: T }>;
  updated: Array<{ name: string; config: T }>;
}

export interface ConfigDiff {
  servers: ServerDiff;
  bridge: {
    logLevel?: LogLevel;
    healthCheckInterval?: number;
    toolPolicy?: ToolPolicy;
    requiresRestart: string[];
  };
}

function connectionFields(config: ServerConfig): Record<string, unknown> {
  if (isStdioServer(config)) {
    return {
      command: config.command,
      args: config.args,
      env: config.env,
    };
  }
  return {
    type: config.type,
    url: config.url,
    headers: config.headers,
    auth: config._bridge?.auth,
  };
}

/** Key-order-independent stringify for deep comparison. */
function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          stableStringify((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

export function diffConfigs(oldConfig: BridgeConfig, newConfig: BridgeConfig): ConfigDiff {
  return {
    servers: diffServers(resolveUpstreams(oldConfig), resolveUpstreams(newConfig)),
    bridge: diffBridgeSettings(oldConfig, newConfig),
  };
}

/** Server changes between two sets of upstreams, by name. */
export function diffServers<T extends ServerConfig>(
  oldServers: Record<string, T>,
  newServers: Record<string, T>,
): ServerDiff<T> {
  const oldNames = new Set(Object.keys(oldServers));
  const newNames = new Set(Object.keys(newServers));

  const added: ServerDiff<T>["added"] = [];
  const removed: string[] = [];
  const reconnect: ServerDiff<T>["reconnect"] = [];
  const updated: ServerDiff<T>["updated"] = [];

  for (const name of newNames) {
    if (!oldNames.has(name)) {
      added.push({ name, config: newServers[name] });
    }
  }

  for (const name of oldNames) {
    if (!newNames.has(name)) {
      removed.push(name);
    }
  }

  for (const name of newNames) {
    if (!oldNames.has(name)) continue;
    const oldCfg = oldServers[name];
    const newCfg = newServers[name];

    if (!deepEqual(connectionFields(oldCfg), connectionFields(newCfg))) {
      reconnect.push({ name, config: newCfg });
    } else if (!deepEqual(oldCfg._bridge, newCfg._bridge)) {
      updated.push({ name, config: newCfg });
    }
  }

  return { added, removed, reconnect, updated };
}

function diffBridgeSettings(oldConfig: BridgeConfig, newConfig: BridgeConfig): ConfigDiff["bridge"] {
  const ob = oldConfig._bridge;
  const nb = newConfig._bridge;
  const bridge: ConfigDiff["bridge"] = { requiresRestart: [] };

  if (ob.logLevel !== nb.logLevel) bridge.logLevel = nb.logLevel;
  if (ob.healthCheckInterval !== nb.healthCheckInterval) bridge.healthCheckInterval = nb.healthCheckInterval;
  if (ob.toolPolicy !== nb.toolPolicy) bridge.toolPolicy = nb.toolPolicy;

  const restartFields = ["port", "logFormat", "maxUpstreamConnections", "connectionTimeout", "idleTimeout"] as const;
  for (const field of restartFields) {
    if (ob[field] !== nb[field]) {
      bridge.requiresRestart.push(field);
    }
  }

  return bridge;
}
