export {
  ToolPolicySchema,
  ServerOAuthConfigSchema,
  ServerBridgeConfigSchema,
  StdioServerConfigSchema,
  HttpServerConfigSchema,
  ServerConfigSchema,
  GlobalBridgeConfigSchema,
  BridgeConfigSchema,
  isHttpServer,
  isStdioServer,
} from "./schema.js";
export type {
  ToolPolicy,
  ServerOAuthConfig,
  ServerBridgeConfig,
  StdioServerConfig,
  HttpServerConfig,
  ServerConfig,
  GlobalBridgeConfig,
  BridgeConfig,
} from "./schema.js";

export {
  loadConfig,
  resolveConfigPath,
  ConfigError,
} from "./loader.js";
export type { LoadConfigOptions, ConfigIssue } from "./loader.js";

export { generateJsonSchema } from "./json-schema.js";

export { diffConfigs } from "./config-diff.js";
export type { ConfigDiff } from "./config-diff.js";

export { ConfigWatcher } from "./config-watcher.js";
export type { ConfigWatcherOptions } from "./config-watcher.js";

export { parseJsoncString } from "./jsonc.js";

export { deepMerge } from "./deep-merge.js";

export {
  BridgeOwnedConfigSchema,
  loadBridgeOwnedConfig,
  saveBridgeOwnedConfig,
  getBridgeConfigPath,
} from "./bridge-config.js";
export type { BridgeOwnedConfig } from "./bridge-config.js";

export { discoverMcpConfigs } from "./discovery.js";
export type { McpConfigEntry } from "./discovery.js";

export { loadMergedConfig } from "./merged-loader.js";
export type { MergedLoaderOptions, MergedLoaderResult } from "./merged-loader.js";
