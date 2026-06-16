import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  HARDCODED_DEFAULT_RATE_LIMIT,
  applyRateLimiters,
  resolveRateLimitConfig,
} from "../../src/server/rate-limit-resolution.js";
import { RateLimiter } from "../../src/server/rate-limiter.js";
import {
  GlobalBridgeConfigSchema,
  type GlobalBridgeConfig,
  type RateLimitConfig,
  type ServerConfig,
} from "../../src/config/schema.js";
import type { Logger } from "../../src/logging/index.js";

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

function fakeLogger(): { logger: Logger; info: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  const logger: Logger = {
    debug: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    setLevel: vi.fn(),
  };
  return { logger, info };
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

describe("applyRateLimiters — startup", () => {
  it("creates a limiter for every upstream when nothing is configured", () => {
    const map = new Map<string, RateLimiter>();
    const { logger } = fakeLogger();

    applyRateLimiters({
      upstreams: { a: stdio(undefined), b: stdio(undefined) },
      global: global(),
      rateLimiters: map,
      logger,
    });

    expect(map.size).toBe(2);
    expect(map.has("a")).toBe(true);
    expect(map.has("b")).toBe(true);
  });

  it("skips disabled upstreams", () => {
    const map = new Map<string, RateLimiter>();
    const { logger } = fakeLogger();

    applyRateLimiters({
      upstreams: {
        a: stdio(false),
        b: stdio(undefined),
        c: stdio(undefined),
      },
      global: global({ defaultRateLimit: false }),
      rateLimiters: map,
      logger,
    });

    // a is explicitly false → no limiter
    expect(map.has("a")).toBe(false);
    // b, c follow global default which is false → no limiter
    expect(map.has("b")).toBe(false);
    expect(map.has("c")).toBe(false);
  });
});

describe("applyRateLimiters — hot reload transitions", () => {
  let map: Map<string, RateLimiter>;
  let logger: Logger;

  beforeEach(() => {
    map = new Map();
    logger = fakeLogger().logger;
  });

  afterEach(() => {
    for (const rl of map.values()) rl.dispose();
  });

  it("default → explicit: limiter stays, callback cleared, fired flag reset", () => {
    applyRateLimiters({
      upstreams: { a: stdio(undefined) },
      global: global(),
      rateLimiters: map,
      logger,
    });
    const a = map.get("a")!;
    const setSpy = vi.spyOn(a, "setOnFirstBlock");
    const reconfigureSpy = vi.spyOn(a, "reconfigure");

    applyRateLimiters({
      upstreams: { a: stdio({ maxCalls: 5, windowSeconds: 2 }) },
      global: global(),
      rateLimiters: map,
      logger,
    });

    expect(map.get("a")).toBe(a); // same instance
    expect(reconfigureSpy).toHaveBeenCalledWith({ maxCalls: 5, windowSeconds: 2 });
    expect(setSpy).toHaveBeenCalledWith(undefined); // explicit source → no callback
  });

  it("explicit → default: callback wired", () => {
    applyRateLimiters({
      upstreams: { a: stdio({ maxCalls: 5, windowSeconds: 2 }) },
      global: global(),
      rateLimiters: map,
      logger,
    });
    const a = map.get("a")!;
    const setSpy = vi.spyOn(a, "setOnFirstBlock");

    applyRateLimiters({
      upstreams: { a: stdio(undefined) },
      global: global(),
      rateLimiters: map,
      logger,
    });

    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]![0]).toBeTypeOf("function");
  });

  it("default → disabled: drainAndDispose, queued waiters resolve", async () => {
    applyRateLimiters({
      upstreams: { a: stdio(undefined) },
      global: global({ defaultRateLimit: { maxCalls: 1, windowSeconds: 60 } }),
      rateLimiters: map,
      logger,
    });
    const a = map.get("a")!;
    await a.acquire(); // fill the window

    const onReject = vi.fn();
    const queued = a.acquire().catch(onReject);

    applyRateLimiters({
      upstreams: { a: stdio(false) },
      global: global(),
      rateLimiters: map,
      logger,
    });

    await queued;
    expect(onReject).not.toHaveBeenCalled();
    expect(map.has("a")).toBe(false);
  });

  it("disabled → default: new limiter created, callback wired", () => {
    applyRateLimiters({
      upstreams: { a: stdio(false) },
      global: global(),
      rateLimiters: map,
      logger,
    });
    expect(map.has("a")).toBe(false);

    applyRateLimiters({
      upstreams: { a: stdio(undefined) },
      global: global(),
      rateLimiters: map,
      logger,
    });
    expect(map.has("a")).toBe(true);
  });

  it("default values change: reconfigure + callback re-armed", () => {
    applyRateLimiters({
      upstreams: { a: stdio(undefined) },
      global: global({ defaultRateLimit: { maxCalls: 10, windowSeconds: 1 } }),
      rateLimiters: map,
      logger,
    });
    const a = map.get("a")!;
    const reconfigureSpy = vi.spyOn(a, "reconfigure");
    const setSpy = vi.spyOn(a, "setOnFirstBlock");

    applyRateLimiters({
      upstreams: { a: stdio(undefined) },
      global: global({ defaultRateLimit: { maxCalls: 20, windowSeconds: 2 } }),
      rateLimiters: map,
      logger,
    });

    expect(reconfigureSpy).toHaveBeenCalledWith({ maxCalls: 20, windowSeconds: 2 });
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]![0]).toBeTypeOf("function");
  });

  it("multi-upstream wipe: every limiter disposed when config goes to {}", () => {
    applyRateLimiters({
      upstreams: { a: stdio(undefined), b: stdio(undefined), c: stdio(undefined) },
      global: global(),
      rateLimiters: map,
      logger,
    });
    expect(map.size).toBe(3);

    applyRateLimiters({
      upstreams: {},
      global: global(),
      rateLimiters: map,
      logger,
    });
    expect(map.size).toBe(0);
  });

  it("upstream removed entirely: dispose() (reject queued)", async () => {
    applyRateLimiters({
      upstreams: { a: stdio(undefined) },
      global: global({ defaultRateLimit: { maxCalls: 1, windowSeconds: 60 } }),
      rateLimiters: map,
      logger,
    });
    const a = map.get("a")!;
    await a.acquire();
    const queued = a.acquire();

    applyRateLimiters({
      upstreams: {},
      global: global(),
      rateLimiters: map,
      logger,
    });

    await expect(queued).rejects.toThrow("Rate limiter disposed");
    expect(map.has("a")).toBe(false);
  });
});

describe("applyRateLimiters — default-block logging", () => {
  it("fires once per upstream on first default-block, silent after", async () => {
    const map = new Map<string, RateLimiter>();
    const { logger, info } = fakeLogger();

    applyRateLimiters({
      upstreams: {
        api: stdio(undefined),
        other: stdio(undefined),
      },
      global: global({ defaultRateLimit: { maxCalls: 1, windowSeconds: 60 } }),
      rateLimiters: map,
      logger,
    });

    const api = map.get("api")!;
    await api.acquire();
    api.acquire().catch(() => {});

    expect(info).toHaveBeenCalledOnce();
    const [msg, ctx] = info.mock.calls[0]!;
    expect(msg).toContain('default rate limit (1 calls / 60s) reached for "api"');
    expect(msg).toContain("_bridge.rateLimit");
    expect(msg).toContain("_bridge.defaultRateLimit: false");
    expect(ctx).toMatchObject({ component: "rate_limit", upstream: "api" });

    // Second block on same upstream is silent.
    api.acquire().catch(() => {});
    expect(info).toHaveBeenCalledOnce();

    for (const rl of map.values()) rl.dispose();
  });

  it("does not fire for explicit per-server limits", async () => {
    const map = new Map<string, RateLimiter>();
    const { logger, info } = fakeLogger();

    applyRateLimiters({
      upstreams: { api: stdio({ maxCalls: 1, windowSeconds: 60 }) },
      global: global(),
      rateLimiters: map,
      logger,
    });

    const api = map.get("api")!;
    await api.acquire();
    api.acquire().catch(() => {});

    expect(info).not.toHaveBeenCalled();
    for (const rl of map.values()) rl.dispose();
  });

  it("config change on a default-following upstream re-arms the log", async () => {
    const map = new Map<string, RateLimiter>();
    const { logger, info } = fakeLogger();

    applyRateLimiters({
      upstreams: { api: stdio(undefined) },
      global: global({ defaultRateLimit: { maxCalls: 1, windowSeconds: 60 } }),
      rateLimiters: map,
      logger,
    });

    const api = map.get("api")!;
    await api.acquire(); // 1 timestamp; window full
    api.acquire().catch(() => {}); // blocks → first log fires
    expect(info).toHaveBeenCalledTimes(1);

    // Bump the default. Reconfigure widens maxCalls to 2 and drains the queued
    // waiter (pushing a second timestamp), so the window is full again at 2/2.
    applyRateLimiters({
      upstreams: { api: stdio(undefined) },
      global: global({ defaultRateLimit: { maxCalls: 2, windowSeconds: 30 } }),
      rateLimiters: map,
      logger,
    });

    // Next acquire blocks → fires the re-armed callback with the new values.
    api.acquire().catch(() => {});
    expect(info).toHaveBeenCalledTimes(2);
    expect(info.mock.calls[1]![0]).toContain("2 calls / 30s");

    for (const rl of map.values()) rl.dispose();
  });
});
