import type {
  GlobalBridgeConfig,
  RateLimitConfig,
  ServerConfig,
} from "../config/schema.js";
import type { Logger } from "../logging/index.js";
import { RateLimiter } from "./rate-limiter.js";

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

function makeDefaultBlockLogger(
  name: string,
  config: RateLimitConfig,
  logger: Logger,
): () => void {
  return () => {
    logger.info(
      `default rate limit (${config.maxCalls} calls / ${config.windowSeconds}s) reached for "${name}"; ` +
        `tune with _bridge.rateLimit or set _bridge.defaultRateLimit: false to opt out`,
      { component: "rate_limit", upstream: name },
    );
  };
}

/**
 * Reconciles the live `rateLimiters` map against the resolved configuration
 * for the given upstreams. Used at startup and on every config hot-reload.
 *
 * Transitions:
 *  - new upstream resolves to a config → create a `RateLimiter`
 *  - existing upstream's config changed → `reconfigure()` + rewire callback
 *  - existing upstream resolves to `disabled` → `drainAndDispose()` (lift = resolve queued)
 *  - upstream vanished from config entirely → `dispose()` (reject queued; server is gone)
 *
 * The "default" source wires a one-shot INFO logger via `onFirstBlock`. Explicit
 * per-server limits do not log.
 */
export function applyRateLimiters(args: {
  upstreams: Record<string, ServerConfig>;
  global: GlobalBridgeConfig;
  rateLimiters: Map<string, RateLimiter>;
  logger: Logger;
}): void {
  const { upstreams, global, rateLimiters, logger } = args;

  // First pass: upstreams still present in config. `disabled` here means the
  // operator lifted the limit (drain — let queued calls fire); a config-change
  // is the user's intent, not a server going away.
  for (const [name, serverConfig] of Object.entries(upstreams)) {
    const resolved = resolveRateLimitConfig(serverConfig, global);
    const existing = rateLimiters.get(name);

    if (resolved.kind === "disabled") {
      if (existing) {
        existing.drainAndDispose();
        rateLimiters.delete(name);
      }
      continue;
    }

    const onFirstBlock =
      resolved.source === "default"
        ? makeDefaultBlockLogger(name, resolved.config, logger)
        : undefined;

    if (existing) {
      // Rewire the callback *before* reconfigure, so any waiter drained by
      // reconfigure() can't see the stale (already-fired) callback.
      existing.setOnFirstBlock(onFirstBlock);
      existing.reconfigure(resolved.config);
    } else {
      rateLimiters.set(name, new RateLimiter(resolved.config, { onFirstBlock }));
    }
  }

  // Second pass: upstreams that vanished from config — server is gone, so
  // queued calls would 404 downstream anyway. Reject rather than drain.
  for (const name of [...rateLimiters.keys()]) {
    if (!(name in upstreams)) {
      rateLimiters.get(name)!.dispose();
      rateLimiters.delete(name);
    }
  }
}
