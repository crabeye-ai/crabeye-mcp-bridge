import { describe, it, expect } from "vitest";
import {
  ServerBridgeConfigSchema,
  ServerOAuthConfigSchema,
  DaemonConfigSchema,
  PassthroughLevelSchema,
} from "../../src/config/schema.js";

describe("config — Phase D sharing config", () => {
  it("ServerBridgeConfigSchema accepts sharing enum and defaults to undefined", () => {
    const parsed = ServerBridgeConfigSchema.parse({});
    expect(parsed.sharing).toBeUndefined();
    expect(ServerBridgeConfigSchema.parse({ sharing: "auto" }).sharing).toBe("auto");
    expect(ServerBridgeConfigSchema.parse({ sharing: "shared" }).sharing).toBe("shared");
    expect(ServerBridgeConfigSchema.parse({ sharing: "dedicated" }).sharing).toBe("dedicated");
    expect(() => ServerBridgeConfigSchema.parse({ sharing: "bogus" })).toThrow();
  });

  it("DaemonConfigSchema exposes auto-fork timeouts with sane defaults", () => {
    const parsed = DaemonConfigSchema.parse({});
    expect(parsed.autoForkDrainTimeoutMs).toBe(60_000);
    expect(parsed.autoForkInitializeTimeoutMs).toBe(10_000);
    expect(() => DaemonConfigSchema.parse({ autoForkDrainTimeoutMs: -1 })).toThrow();
  });
});

describe("DaemonConfigSchema — Phase E additions", () => {
  it("defaults rpcTimeoutMs to 30000", () => {
    const cfg = DaemonConfigSchema.parse({});
    expect(cfg.rpcTimeoutMs).toBe(30_000);
  });

  it("defaults heartbeatMs to 5000", () => {
    const cfg = DaemonConfigSchema.parse({});
    expect(cfg.heartbeatMs).toBe(5_000);
  });

  it("defaults respawnLockWaitMs to 60000", () => {
    const cfg = DaemonConfigSchema.parse({});
    expect(cfg.respawnLockWaitMs).toBe(60_000);
  });

  it("rejects non-positive rpcTimeoutMs", () => {
    expect(() => DaemonConfigSchema.parse({ rpcTimeoutMs: 0 })).toThrow();
  });

  it("rejects non-positive heartbeatMs", () => {
    expect(() => DaemonConfigSchema.parse({ heartbeatMs: 0 })).toThrow();
  });

  it("accepts custom values", () => {
    const cfg = DaemonConfigSchema.parse({
      rpcTimeoutMs: 15_000,
      heartbeatMs: 2_000,
      respawnLockWaitMs: 10_000,
    });
    expect(cfg).toMatchObject({
      rpcTimeoutMs: 15_000,
      heartbeatMs: 2_000,
      respawnLockWaitMs: 10_000,
    });
  });
});

describe("ServerBridgeConfigSchema — passthrough (AIT-183)", () => {
  it("accepts every documented passthrough level", () => {
    expect(PassthroughLevelSchema.parse(false)).toBe(false);
    expect(PassthroughLevelSchema.parse("instructions")).toBe("instructions");
    expect(PassthroughLevelSchema.parse("tools")).toBe("tools");
    expect(PassthroughLevelSchema.parse("full")).toBe("full");
  });

  it("rejects literal true so callers must pick a level explicitly", () => {
    expect(() => PassthroughLevelSchema.parse(true)).toThrow();
    expect(() =>
      ServerBridgeConfigSchema.parse({ passthrough: true }),
    ).toThrow();
  });

  it("rejects unknown string levels", () => {
    expect(() => PassthroughLevelSchema.parse("partial")).toThrow();
    expect(() =>
      ServerBridgeConfigSchema.parse({ passthrough: "everything" }),
    ).toThrow();
  });

  it("passthroughMaxBytes accepts positive integers", () => {
    const cfg = ServerBridgeConfigSchema.parse({
      passthrough: "tools",
      passthroughMaxBytes: 1024,
    });
    expect(cfg.passthroughMaxBytes).toBe(1024);
  });

  it("passthroughMaxBytes rejects zero, negatives, and non-integers", () => {
    expect(() =>
      ServerBridgeConfigSchema.parse({ passthroughMaxBytes: 0 }),
    ).toThrow();
    expect(() =>
      ServerBridgeConfigSchema.parse({ passthroughMaxBytes: -10 }),
    ).toThrow();
    expect(() =>
      ServerBridgeConfigSchema.parse({ passthroughMaxBytes: 1.5 }),
    ).toThrow();
  });

  it("passthroughMaxBytes is bounded at 1 MiB", () => {
    expect(
      ServerBridgeConfigSchema.parse({ passthroughMaxBytes: 1_048_576 })
        .passthroughMaxBytes,
    ).toBe(1_048_576);
    expect(() =>
      ServerBridgeConfigSchema.parse({ passthroughMaxBytes: 1_048_577 }),
    ).toThrow();
  });

  it("defaults to undefined (no passthrough) when unset", () => {
    const cfg = ServerBridgeConfigSchema.parse({});
    expect(cfg.passthrough).toBeUndefined();
    expect(cfg.passthroughMaxBytes).toBeUndefined();
  });
});

describe("ServerOAuthConfigSchema — endpoint trust (AIT-122)", () => {
  const base = {
    type: "oauth2" as const,
    clientId: "ci",
    endpoints: {
      authorization: "https://provider.example.com/authorize",
      token: "https://provider.example.com/token",
    },
  };

  it("accepts http(s) same-origin endpoints", () => {
    expect(() => ServerOAuthConfigSchema.parse(base)).not.toThrow();
    expect(() =>
      ServerOAuthConfigSchema.parse({
        ...base,
        endpoints: {
          authorization: "http://localhost:8080/authorize",
          token: "http://localhost:8080/token",
        },
      }),
    ).not.toThrow();
  });

  it("rejects non-http(s) schemes on authorization endpoint", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "vscode://workspace",
    ]) {
      expect(() =>
        ServerOAuthConfigSchema.parse({
          ...base,
          endpoints: { authorization: url, token: base.endpoints.token },
        }),
      ).toThrow(/authorization endpoint must use http or https/);
    }
  });

  it("rejects non-http(s) schemes on token endpoint", () => {
    expect(() =>
      ServerOAuthConfigSchema.parse({
        ...base,
        endpoints: {
          authorization: base.endpoints.authorization,
          token: "file:///tmp/leaked",
        },
      }),
    ).toThrow(/token endpoint must use http or https/);
  });

  it("rejects cross-origin token endpoint", () => {
    expect(() =>
      ServerOAuthConfigSchema.parse({
        ...base,
        endpoints: {
          authorization: "https://real-provider.example.com/authorize",
          token: "https://attacker.example.com/exchange",
        },
      }),
    ).toThrow(/origin.*must match authorization endpoint origin/);
  });

  it("accepts redirectPort and clientSecret as optional", () => {
    const cfg = ServerOAuthConfigSchema.parse({
      ...base,
      redirectPort: 19876,
      clientSecret: "${OAUTH_NOTION_SECRET}",
    });
    expect(cfg.redirectPort).toBe(19876);
    expect(cfg.clientSecret).toBe("${OAUTH_NOTION_SECRET}");
  });

  it("rejects privileged redirectPort (<1024)", () => {
    for (const port of [80, 443, 22, 1023]) {
      expect(() =>
        ServerOAuthConfigSchema.parse({ ...base, redirectPort: port }),
      ).toThrow();
    }
    expect(() =>
      ServerOAuthConfigSchema.parse({ ...base, redirectPort: 1024 }),
    ).not.toThrow();
  });
});
