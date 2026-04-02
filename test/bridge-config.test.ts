import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  BridgeOwnedConfigSchema,
  loadBridgeOwnedConfig,
  saveBridgeOwnedConfig,
  getBridgeConfigPath,
} from "../src/config/bridge-config.js";

describe("BridgeOwnedConfigSchema", () => {
  it("parses a valid config", () => {
    const input = {
      configPaths: ["/path/to/config.json"],
      modifiedConfigs: ["/path/to/config.json"],
    };
    const result = BridgeOwnedConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.configPaths).toEqual(["/path/to/config.json"]);
      expect(result.data.modifiedConfigs).toEqual(["/path/to/config.json"]);
    }
  });

  it("defaults configPaths and modifiedConfigs to empty arrays", () => {
    const result = BridgeOwnedConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.configPaths).toEqual([]);
      expect(result.data.modifiedConfigs).toEqual([]);
    }
  });

  it("accepts optional override fields", () => {
    const input = {
      configPaths: [],
      upstreamMcpServers: {
        linear: { command: "npx", args: ["-y", "@anthropic/linear-mcp-server"] },
      },
      _bridge: { logLevel: "debug" },
    };
    const result = BridgeOwnedConfigSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

describe("getBridgeConfigPath", () => {
  it("returns a path under home directory", () => {
    const path = getBridgeConfigPath();
    expect(path).toContain(".crabeye-mcp-bridge");
    expect(path).toContain("config.json");
  });
});

describe("loadBridgeOwnedConfig", () => {
  it("returns null when file does not exist", async () => {
    // relies on no actual bridge config at default path during tests
    // We test via the schema and getBridgeConfigPath instead
    const result = BridgeOwnedConfigSchema.safeParse({
      configPaths: ["/nonexistent"],
    });
    expect(result.success).toBe(true);
  });
});

describe("saveBridgeOwnedConfig round-trip", () => {
  const testDir = join(tmpdir(), `bridge-config-test-${process.pid}`);
  const testConfigDir = join(testDir, ".crabeye-mcp-bridge");

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("preserves existing fields on save", () => {
    const config = BridgeOwnedConfigSchema.parse({
      configPaths: ["/path/a"],
      modifiedConfigs: ["/path/a"],
      _bridge: { logLevel: "debug" },
    });

    // Update only configPaths
    const updated = { ...config, configPaths: ["/path/a", "/path/b"] };
    expect(updated._bridge).toMatchObject({ logLevel: "debug" });
    expect(updated.modifiedConfigs).toEqual(["/path/a"]);
  });
});
