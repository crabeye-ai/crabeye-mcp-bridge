import type { BridgeConfig, ServerConfig, ToolPolicy } from "./schema.js";
import { resolveUpstreams } from "./schema.js";
import type { LogLevel } from "../logging/index.js";

export interface ServerDiff {
  added: Array<{ name: string; config: ServerConfig }>;
  removed: string[];
  /** Servers kept under the same name whose entry changed in any way. */
  changed: Array<{ name: string; config: ServerConfig }>;
}

export interface ConfigDiff {
  servers: ServerDiff;
  bridge: {
    logLevel?: LogLevel;
    toolPolicy?: ToolPolicy;
    requiresRestart: string[];
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

function diffServers(
  oldServers: Record<string, ServerConfig>,
  newServers: Record<string, ServerConfig>,
): ServerDiff {
  const oldNames = new Set(Object.keys(oldServers));
  const newNames = new Set(Object.keys(newServers));

  const added: ServerDiff["added"] = [];
  const removed: string[] = [];
  const changed: ServerDiff["changed"] = [];

  for (const name of newNames) {
    if (!oldNames.has(name)) added.push({ name, config: newServers[name] });
    else if (!deepEqual(oldServers[name], newServers[name])) changed.push({ name, config: newServers[name] });
  }

  for (const name of oldNames) {
    if (!newNames.has(name)) removed.push(name);
  }

  return { added, removed, changed };
}

function diffBridgeSettings(oldConfig: BridgeConfig, newConfig: BridgeConfig): ConfigDiff["bridge"] {
  const ob = oldConfig._bridge;
  const nb = newConfig._bridge;
  const bridge: ConfigDiff["bridge"] = { requiresRestart: [] };

  if (ob.logLevel !== nb.logLevel) bridge.logLevel = nb.logLevel;
  if (ob.toolPolicy !== nb.toolPolicy) bridge.toolPolicy = nb.toolPolicy;

  const restartFields = ["port", "logFormat", "maxUpstreamConnections", "connectionTimeout", "idleTimeout"] as const;
  for (const field of restartFields) {
    if (ob[field] !== nb[field]) {
      bridge.requiresRestart.push(field);
    }
  }

  return bridge;
}
