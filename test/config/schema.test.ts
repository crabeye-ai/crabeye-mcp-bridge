import { describe, it, expect } from "vitest";
import {
  ServerBridgeConfigSchema,
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
