import { z } from "zod";
import { APP_NAME } from "../constants.js";

// --- Tool policy ---

export const ToolPolicySchema = z.enum(["always", "never", "prompt"]);

// --- Per-server auth config ---

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * `z.string().url()` happily accepts `javascript:`, `file://`, custom app
 * schemes, etc. The auth flow hands the authorization URL to the OS browser
 * launcher and POSTs to the token endpoint, so a tampered config could turn
 * either into an exfiltration vector or a local-handler exploit. Restrict to
 * http(s), and pin token to the same origin as authorization so a config
 * can't redirect just the code-exchange leg to an attacker URL.
 */
const OAuthEndpointsSchema = z
  .object({
    authorization: z.string().url(),
    token: z.string().url(),
  })
  .superRefine((endpoints, ctx) => {
    if (!isHttpUrl(endpoints.authorization)) {
      ctx.addIssue({
        code: "custom",
        path: ["authorization"],
        message: "authorization endpoint must use http or https",
      });
    }
    if (!isHttpUrl(endpoints.token)) {
      ctx.addIssue({
        code: "custom",
        path: ["token"],
        message: "token endpoint must use http or https",
      });
    }
    if (isHttpUrl(endpoints.authorization) && isHttpUrl(endpoints.token)) {
      const a = new URL(endpoints.authorization).origin;
      const t = new URL(endpoints.token).origin;
      if (a !== t) {
        ctx.addIssue({
          code: "custom",
          path: ["token"],
          message: `token endpoint origin (${t}) must match authorization endpoint origin (${a})`,
        });
      }
    }
  });

/**
 * Per-server OAuth config. Most fields are optional now that the bridge uses
 * the MCP SDK's RFC 9728 / RFC 8414 discovery and RFC 7591 dynamic client
 * registration. Configure these only to override what discovery returns or
 * to pin a pre-registered client.
 *
 * Minimal config: `{ type: "oauth2" }` — everything else is discovered.
 */
export const ServerOAuthConfigSchema = z.object({
  type: z.literal("oauth2"),
  /** Pre-registered client_id. When omitted, the bridge dynamically registers. */
  clientId: z.string().optional(),
  /** Pinned authorization/token endpoints. When omitted, RFC 8414 discovery is used. */
  endpoints: OAuthEndpointsSchema.optional(),
  scopes: z.array(z.string()).optional(),
  /**
   * Pin the loopback redirect port used during the `auth` flow. Default:
   * random free port. Restricted to >=1024 — binding privileged ports
   * needs root, and a malicious local process colluding with a tampered
   * config to pre-bind a low port is the easier attack we want to remove.
   */
  redirectPort: z.number().int().min(1024).max(65535).optional(),
  /**
   * Optional client secret for confidential clients. Supports
   * `${ENV_VAR}` interpolation, resolved at config-load time (env var name
   * must contain "OAUTH"). If unset, the resolver falls back to
   * credential-store key `oauth-client-secret:<server>`. Plain strings work
   * but are discouraged (config files are often shared).
   */
  clientSecret: z.string().optional(),
});

export const RateLimitConfigSchema = z.object({
  maxCalls: z.number().int().positive(),
  windowSeconds: z.number().int().positive(),
});

export const ReconnectConfigSchema = z.object({
  maxReconnectAttempts: z.number().int().min(0).optional(),
  reconnectBaseDelay: z.number().int().positive().optional(),
  reconnectMaxDelay: z.number().int().positive().optional(),
});

/**
 * Per-server context-passthrough level. Controls how much of an upstream's
 * `initialize.instructions` and tool list gets injected into the bridge's
 * downstream instructions string at handshake. The literal `true` is not
 * accepted — callers must pick a level explicitly.
 */
export const PassthroughLevelSchema = z.union([
  z.literal(false),
  z.enum(["instructions", "tools", "full"]),
]);

export const ServerBridgeConfigSchema = z
  .object({
    auth: ServerOAuthConfigSchema.optional(),
    toolPolicy: ToolPolicySchema.optional(),
    tools: z.record(z.string(), ToolPolicySchema).optional(),
    category: z.string().optional(),
    rateLimit: RateLimitConfigSchema.optional(),
    reconnect: ReconnectConfigSchema.optional(),
    sharing: z.enum(["auto", "shared", "dedicated"]).optional(),
    passthrough: PassthroughLevelSchema.optional(),
    /**
     * Per-server byte cap on the rendered passthrough block. Bounded at 1
     * MiB at the schema layer; the renderer enforces an additional 256 KiB
     * default ceiling when this is unset.
     */
    passthroughMaxBytes: z.number().int().positive().max(1_048_576).optional(),
  })
  .strict();

// --- Server configs ---

export const StdioServerConfigSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  /**
   * Working directory for the spawned child. When unset, the daemon inherits
   * its own cwd. Captured in `upstreamHash` so two upstreams that differ only
   * in cwd hash differently and don't share a child.
   */
  cwd: z.string().optional(),
  _bridge: ServerBridgeConfigSchema.optional(),
});

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export const HttpServerConfigSchema = z
  .object({
    type: z
      .enum(["streamable-http", "http", "streamableHttp", "sse"])
      .default("streamable-http"),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    _bridge: ServerBridgeConfigSchema.optional(),
  })
  .superRefine((server, ctx) => {
    // When `_bridge.auth` is configured, refuse plain-http upstreams that
    // aren't loopback. The bridge's connection to the upstream is otherwise
    // unencrypted, so a network-positioned attacker can serve tampered RFC
    // 9728 / 8414 metadata that redirects the token endpoint to an
    // attacker-controlled origin and exfiltrates the authorization code,
    // PKCE verifier, and client secret.
    if (!server._bridge?.auth) return;
    let parsed: URL;
    try {
      parsed = new URL(server.url);
    } catch {
      return; // url validation will surface this separately
    }
    if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
      ctx.addIssue({
        code: "custom",
        path: ["url"],
        message:
          "OAuth-configured upstreams must use https (non-loopback hosts). " +
          `Got http://${parsed.host} — a MITM could inject AS metadata.`,
      });
    }
  });

// HTTP first: it has a required `type` field that disambiguates
export const ServerConfigSchema = z.union([
  HttpServerConfigSchema,
  StdioServerConfigSchema,
]);

// --- Global bridge config ---

export const DaemonConfigSchema = z
  .object({
    idleMs: z.number().int().positive().default(60_000),
    /** Idle-child grace before SIGTERM. Starts when a child's refcount drops to 0. Cancelled on new attach. */
    graceMs: z.number().int().nonnegative().default(60_000),
    /** SIGTERM→SIGKILL window once kill is dispatched. */
    killGraceMs: z.number().int().nonnegative().default(2_000),
    autoForkDrainTimeoutMs: z.number().int().nonnegative().default(60_000),
    autoForkInitializeTimeoutMs: z.number().int().nonnegative().default(10_000),
    /** Per-RPC timeout the bridge applies to outbound daemon calls. Was hardcoded 10000 in DaemonStdioTransport. */
    rpcTimeoutMs: z.number().int().positive().default(30_000),
    /** Bridge sends `PING` on this cadence. Missed `PONG` for `heartbeatMs * 3` triggers a liveness failure. */
    heartbeatMs: z.number().int().positive().default(5_000),
    /** How long a losing bridge waits on `manager.lock` after detecting a dead daemon before surfacing `ERR_UPSTREAM_RESTARTED`. */
    respawnLockWaitMs: z.number().int().positive().default(60_000),
  })
  .strict();

export const GlobalBridgeConfigSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(19875),
    logLevel: z
      .enum(["debug", "info", "warn", "error"])
      .default("info"),
    logFormat: z.enum(["text", "json"]).default("text"),
    maxUpstreamConnections: z.number().int().positive().default(1000),
    connectionTimeout: z.number().int().positive().default(30),
    idleTimeout: z.number().int().positive().default(600),
    healthCheckInterval: z.number().int().min(0).default(30),
    toolPolicy: ToolPolicySchema.default("always"),
    reconnect: ReconnectConfigSchema.optional(),
    daemon: DaemonConfigSchema.default(DaemonConfigSchema.parse({})),
  })
  .strict();

// --- Top-level config ---

export const BridgeConfigSchema = z.object({
  mcpServers: z.record(z.string(), ServerConfigSchema).default({}),
  upstreamMcpServers: z.record(z.string(), ServerConfigSchema).optional(),
  upstreamServers: z.record(z.string(), ServerConfigSchema).optional(),
  servers: z.record(z.string(), ServerConfigSchema).optional(),
  context_servers: z.record(z.string(), ServerConfigSchema).optional(),
  _bridge: GlobalBridgeConfigSchema.default(
    GlobalBridgeConfigSchema.parse({}),
  ),
});

// --- Inferred types ---

export type ToolPolicy = z.infer<typeof ToolPolicySchema>;
export type PassthroughLevel = z.infer<typeof PassthroughLevelSchema>;
export type RateLimitConfig = z.infer<typeof RateLimitConfigSchema>;
export type ReconnectConfig = z.infer<typeof ReconnectConfigSchema>;
export type ServerOAuthConfig = z.infer<typeof ServerOAuthConfigSchema>;
export type ServerBridgeConfig = z.infer<typeof ServerBridgeConfigSchema>;
export type StdioServerConfig = z.infer<typeof StdioServerConfigSchema>;
export type HttpServerConfig = z.infer<typeof HttpServerConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type GlobalBridgeConfig = z.infer<typeof GlobalBridgeConfigSchema>;
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

// --- Upstream resolution ---

/**
 * Resolves which servers to use as upstreams.
 *
 * Returns the union of all present config keys. On duplicate names,
 * earlier sources win:
 * `upstreamMcpServers` > `upstreamServers` > `servers` > `context_servers` > `mcpServers`.
 *
 * Self-exclusion: entries from `mcpServers` and `context_servers` whose
 * `command` or `args` contain the app name are filtered out.
 */
export function resolveUpstreams(
  config: BridgeConfig,
): Record<string, ServerConfig> {
  const result: Record<string, ServerConfig> = {};

  // mcpServers (lowest priority, with self-exclusion)
  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (isStdioServer(server)) {
      const tokens = [server.command, ...(server.args ?? [])];
      if (tokens.some((t) => t.includes(APP_NAME))) {
        continue;
      }
    }
    result[name] = server;
  }

  // context_servers (with self-exclusion, above mcpServers)
  if (config.context_servers) {
    for (const [name, server] of Object.entries(config.context_servers)) {
      if (isStdioServer(server)) {
        const tokens = [server.command, ...(server.args ?? [])];
        if (tokens.some((t) => t.includes(APP_NAME))) {
          continue;
        }
      }
      result[name] = server;
    }
  }

  // servers (above context_servers)
  if (config.servers) {
    Object.assign(result, config.servers);
  }

  // upstreamServers (above servers)
  if (config.upstreamServers) {
    Object.assign(result, config.upstreamServers);
  }

  // upstreamMcpServers (highest priority)
  if (config.upstreamMcpServers) {
    Object.assign(result, config.upstreamMcpServers);
  }

  return result;
}

// --- Type guards ---

export function isHttpServer(config: ServerConfig): config is HttpServerConfig {
  // HttpServerConfigSchema requires `url`; stdio configs never carry one.
  // Discriminating on `url` is structurally tighter than the previous
  // `"type" in config` check: stdio entries with an extraneous `type` field
  // (legacy editors, third-party tools) won't mis-classify.
  return "url" in config;
}

export function isStdioServer(
  config: ServerConfig,
): config is StdioServerConfig {
  return "command" in config;
}
