import type {
  GlobalBridgeConfig,
  RateLimitConfig,
  ServerConfig,
} from "../config/schema.js";

/**
 * Fallback rate limit applied to every upstream that didn't pick one and
 * doesn't have a global default set. Averages 5 req/s, smoothed across a
 * 6-second window so a bursty LLM turn (10-15 tool calls at once) doesn't
 * stall on the first hit.
 */
export const HARDCODED_DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxCalls: 30,
  windowSeconds: 6,
};

export type ResolvedRateLimit =
  | {
      kind: "config";
      config: RateLimitConfig;
      /**
       * `explicit`  → per-server `_bridge.rateLimit` is set
       * `default`   → following `_bridge.defaultRateLimit` or the hardcoded fallback
       */
      source: "explicit" | "default";
    }
  | { kind: "disabled" };

/**
 * Resolution order (first match wins):
 *   1. per-server `_bridge.rateLimit === false` → disabled
 *   2. per-server `_bridge.rateLimit` object    → explicit
 *   3. global `_bridge.defaultRateLimit === false` → disabled
 *   4. global `_bridge.defaultRateLimit` object    → default
 *   5. otherwise                                    → hardcoded default
 */
export function resolveRateLimitConfig(
  serverConfig: ServerConfig,
  global: GlobalBridgeConfig,
): ResolvedRateLimit {
  const perServer = serverConfig._bridge?.rateLimit;
  if (perServer === false) return { kind: "disabled" };
  if (perServer) return { kind: "config", config: perServer, source: "explicit" };

  const globalDefault = global.defaultRateLimit;
  if (globalDefault === false) return { kind: "disabled" };
  if (globalDefault) {
    return { kind: "config", config: globalDefault, source: "default" };
  }

  return {
    kind: "config",
    config: HARDCODED_DEFAULT_RATE_LIMIT,
    source: "default",
  };
}

/** The one-time hint for when a default limit first makes a call to `name` wait. */
export function defaultLimitReachedMessage(name: string, config: RateLimitConfig): string {
  return (
    `default rate limit (${config.maxCalls} calls / ${config.windowSeconds}s) reached for "${name}"; ` +
    `tune with _bridge.rateLimit or set _bridge.defaultRateLimit: false to opt out`
  );
}
