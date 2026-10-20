import type { Logger } from "../logging/index.js";
import { resolveUpstreams, type BridgeConfig, type ServerConfig } from "./schema.js";

const RETRIES_FOREVER = "upstreams now retry indefinitely with capped backoff";
const ONE_SHARED_PROCESS = "every bridge shares one process per STDIO server";

interface RemovedSetting {
  setting: string;
  locate: (config: BridgeConfig) => string[];
  reason: string;
}

export interface RemovedSettingInUse {
  setting: string;
  locations: string[];
  reason: string;
}

const REMOVED_SETTINGS: RemovedSetting[] = [
  {
    setting: "maxReconnectAttempts",
    locate: (config) => [
      ...inBridgeSection(config._bridge.reconnect?.maxReconnectAttempts),
      ...inServers(config, (server) => server._bridge?.reconnect?.maxReconnectAttempts),
    ],
    reason: RETRIES_FOREVER,
  },
  {
    setting: "sharing",
    locate: (config) => inServers(config, (server) => server._bridge?.sharing),
    reason: ONE_SHARED_PROCESS,
  },
  {
    setting: "daemon.autoForkDrainTimeoutMs",
    locate: (config) => inBridgeSection(config._bridge.daemon.autoForkDrainTimeoutMs),
    reason: ONE_SHARED_PROCESS,
  },
  {
    setting: "daemon.autoForkInitializeTimeoutMs",
    locate: (config) => inBridgeSection(config._bridge.daemon.autoForkInitializeTimeoutMs),
    reason: ONE_SHARED_PROCESS,
  },
];

function inBridgeSection(value: unknown): string[] {
  return value === undefined ? [] : ["_bridge"];
}

function inServers(config: BridgeConfig, valueOf: (server: ServerConfig) => unknown): string[] {
  return Object.entries(resolveUpstreams(config))
    .filter(([, server]) => valueOf(server) !== undefined)
    .map(([name]) => `server "${name}"`);
}

export function findRemovedSettings(config: BridgeConfig): RemovedSettingInUse[] {
  return REMOVED_SETTINGS.map(({ setting, locate, reason }) => ({ setting, locations: locate(config), reason })).filter(
    ({ locations }) => locations.length > 0,
  );
}

export function warnRemovedSettings(config: BridgeConfig, logger: Logger): void {
  for (const { setting, locations, reason } of findRemovedSettings(config)) {
    logger.warn(`${setting} no longer has any effect and is ignored (${locations.join(", ")}); ${reason}`, {
      component: "config",
    });
  }
}
