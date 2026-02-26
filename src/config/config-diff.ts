import type { BridgeConfig, ServerConfig, ToolPolicy } from "./schema.js";
import { resolveUpstreams, isStdioServer } from "./schema.js";
import type { LogLevel } from "../logging/index.js";

export interface ConfigDiff {
  servers: {
    added: Array<{ name: string; config: ServerConfig }>;
    removed: string[];
    reconnect: Array<{ name: string; config: ServerConfig }>;
    updated: Array<{ name: string; config: ServerConfig }>;
  };
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
  const oldServers = resolveUpstreams(oldConfig);
  const newServers = resolveUpstreams(newConfig);

  const oldNames = new Set(Object.keys(oldServers));
  const newNames = new Set(Object.keys(newServers));

  const added: ConfigDiff["servers"]["added"] = [];
  const removed: string[] = [];
  const reconnect: ConfigDiff["servers"]["reconnect"] = [];
  const updated: ConfigDiff["servers"]["updated"] = [];

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

  // Bridge-level changes
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

  return {
    servers: { added, removed, reconnect, updated },
    bridge,
  };
}
