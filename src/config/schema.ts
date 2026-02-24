import { z } from "zod";

// --- Per-server auth config ---

export const ServerOAuthConfigSchema = z.object({
  type: z.literal("oauth2"),
  clientId: z.string(),
  endpoints: z.object({
    authorization: z.string().url(),
    token: z.string().url(),
  }),
  scopes: z.array(z.string()).optional(),
});

export const ServerBridgeConfigSchema = z
  .object({
    auth: ServerOAuthConfigSchema.optional(),
  })
  .strict();

// --- Server configs ---

export const StdioServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  _bridge: ServerBridgeConfigSchema.optional(),
});

export const HttpServerConfigSchema = z.object({
  type: z.enum(["streamable-http", "sse"]),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  _bridge: ServerBridgeConfigSchema.optional(),
});

// HTTP first: it has a required `type` field that disambiguates
export const ServerConfigSchema = z.union([
  HttpServerConfigSchema,
  StdioServerConfigSchema,
]);

// --- Global bridge config ---

export const GlobalBridgeConfigSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(19875),
    logLevel: z
      .enum(["debug", "info", "warn", "error"])
      .default("info"),
    maxUpstreamConnections: z.number().int().positive().default(20),
    connectionTimeout: z.number().int().positive().default(30),
    idleTimeout: z.number().int().positive().default(600),
  })
  .strict();

// --- Top-level config ---

export const BridgeConfigSchema = z.object({
  mcpServers: z.record(z.string(), ServerConfigSchema),
  _bridge: GlobalBridgeConfigSchema.default({}),
});

// --- Inferred types ---

export type ServerOAuthConfig = z.infer<typeof ServerOAuthConfigSchema>;
export type ServerBridgeConfig = z.infer<typeof ServerBridgeConfigSchema>;
export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>;
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type GlobalBridgeConfig = z.infer<typeof GlobalBridgeConfigSchema>;
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

// --- Type guards ---

export function isHttpServer(config: ServerConfig): config is HttpServerConfig {
  return "type" in config;
}

export function isStdioServer(
  config: ServerConfig,
): config is StdioServerConfig {
  return "command" in config;
}
