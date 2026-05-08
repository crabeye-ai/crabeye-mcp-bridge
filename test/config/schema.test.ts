import { describe, it, expect } from "vitest";
import {
  ServerBridgeConfigSchema,
  DaemonConfigSchema,
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
