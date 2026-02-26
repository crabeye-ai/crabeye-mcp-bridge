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
