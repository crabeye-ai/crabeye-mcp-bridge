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
