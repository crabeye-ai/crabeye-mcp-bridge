export {
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
