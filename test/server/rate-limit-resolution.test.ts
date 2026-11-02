import { describe, it, expect } from "vitest";
import {
  HARDCODED_DEFAULT_RATE_LIMIT,
  defaultLimitReachedMessage,
  resolveRateLimitConfig,
} from "../../src/server/rate-limit-resolution.js";
import {
  GlobalBridgeConfigSchema,
  type GlobalBridgeConfig,
  type RateLimitConfig,
  type ServerConfig,
} from "../../src/config/schema.js";

const STDIO: Omit<Extract<ServerConfig, { command: string }>, "_bridge"> = {
  command: "node",
  args: [],
};

function stdio(rateLimit?: RateLimitConfig | false): ServerConfig {
  return {
    ...STDIO,
    _bridge: rateLimit === undefined ? undefined : { rateLimit },
  };
}

function global(
  overrides: { defaultRateLimit?: GlobalBridgeConfig["defaultRateLimit"] } = {},
): GlobalBridgeConfig {
  return GlobalBridgeConfigSchema.parse({
    ...(overrides.defaultRateLimit === undefined
      ? {}
      : { defaultRateLimit: overrides.defaultRateLimit }),
  });
}

describe("resolveRateLimitConfig", () => {
  it("case 1: per-server `false` → disabled", () => {
    expect(resolveRateLimitConfig(stdio(false), global())).toEqual({
      kind: "disabled",
    });
  });

  it("case 2: per-server object → explicit", () => {
    expect(
      resolveRateLimitConfig(
        stdio({ maxCalls: 10, windowSeconds: 1 }),
        global({ defaultRateLimit: { maxCalls: 99, windowSeconds: 99 } }),
      ),
    ).toEqual({
      kind: "config",
      config: { maxCalls: 10, windowSeconds: 1 },
      source: "explicit",
    });
  });

  it("case 2 short-circuits even when global default is `false`", () => {
    expect(
      resolveRateLimitConfig(
        stdio({ maxCalls: 5, windowSeconds: 1 }),
        global({ defaultRateLimit: false }),
      ),
    ).toEqual({
      kind: "config",
      config: { maxCalls: 5, windowSeconds: 1 },
      source: "explicit",
    });
  });

  it("case 3: global `false` → disabled for upstreams without their own", () => {
    expect(
      resolveRateLimitConfig(stdio(undefined), global({ defaultRateLimit: false })),
    ).toEqual({ kind: "disabled" });
  });

  it("case 4: global object → default", () => {
    expect(
      resolveRateLimitConfig(
        stdio(undefined),
        global({ defaultRateLimit: { maxCalls: 7, windowSeconds: 3 } }),
      ),
    ).toEqual({
      kind: "config",
      config: { maxCalls: 7, windowSeconds: 3 },
      source: "default",
    });
  });

  it("case 5: no per-server, no global → hardcoded default", () => {
    expect(resolveRateLimitConfig(stdio(undefined), global())).toEqual({
      kind: "config",
      config: HARDCODED_DEFAULT_RATE_LIMIT,
      source: "default",
    });
  });

  it("hardcoded default is 30/6", () => {
    expect(HARDCODED_DEFAULT_RATE_LIMIT).toEqual({
      maxCalls: 30,
      windowSeconds: 6,
    });
  });
});

describe("defaultLimitReachedMessage", () => {
  it("names the server and the limit, and says how to tune or opt out", () => {
    expect(defaultLimitReachedMessage("linear", { maxCalls: 30, windowSeconds: 6 })).toBe(
      'default rate limit (30 calls / 6s) reached for "linear"; tune with _bridge.rateLimit or set _bridge.defaultRateLimit: false to opt out',
    );
  });
});
