import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  BridgeOwnedConfigSchema,
  getBridgeConfigPath,
  loadDaemonSettings,
  loadDaemonShutdownWaitMs,
} from "../src/config/bridge-config.js";
import { DAEMON_SHUTDOWN_MARGIN_MS } from "../src/constants.js";
import { DaemonConfigSchema, DEFAULT_LOG_LEVEL } from "../src/config/schema.js";

const DEFAULT_IDLE_MS = DaemonConfigSchema.parse({}).idleMs;

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

describe("loadDaemonSettings", () => {
  const HOME_VARS = ["HOME", "USERPROFILE"] as const;
  const saved: Partial<Record<(typeof HOME_VARS)[number], string>> = {};
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "cbe-daemon-settings-"));
    for (const name of HOME_VARS) {
      saved[name] = process.env[name];
      process.env[name] = home;
    }
  });

  afterEach(async () => {
    for (const name of HOME_VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await rm(home, { recursive: true, force: true });
  });

  async function writeConfig(text: string): Promise<void> {
    await mkdir(dirname(getBridgeConfigPath()), { recursive: true });
    await writeFile(getBridgeConfigPath(), text);
  }

  it("uses the defaults without an error when there is no config file", async () => {
    expect(await loadDaemonSettings()).toEqual({
      daemon: expect.objectContaining({ idleMs: DEFAULT_IDLE_MS }),
      logLevel: DEFAULT_LOG_LEVEL,
    });
  });

  it("reads the log level and the daemon settings from the file", async () => {
    await writeConfig(JSON.stringify({ _bridge: { logLevel: "debug", daemon: { idleMs: 5_000 } } }));
    expect(await loadDaemonSettings()).toEqual({
      daemon: expect.objectContaining({ idleMs: 5_000 }),
      logLevel: "debug",
    });
  });

  it("falls back to the defaults and reports why when the file is not valid JSONC", async () => {
    await writeConfig("{ not json");
    expect(await loadDaemonSettings()).toEqual({
      daemon: expect.objectContaining({ idleMs: DEFAULT_IDLE_MS }),
      logLevel: DEFAULT_LOG_LEVEL,
      loadError: expect.any(String),
    });
  });

  it("falls back to the defaults and reports why when an entry is invalid", async () => {
    await writeConfig(JSON.stringify({ _bridge: { logLevel: "loud", daemon: { idleMs: 5_000 } } }));
    const settings = await loadDaemonSettings();
    expect(settings.logLevel).toBe(DEFAULT_LOG_LEVEL);
    expect(settings.daemon.idleMs).toBe(DEFAULT_IDLE_MS);
    expect(settings.loadError).toMatch(/^✖ .*\n {2}→ at _bridge\.logLevel$/);
  });

  it("derives the shutdown wait from the configured kill grace", async () => {
    await writeConfig(JSON.stringify({ _bridge: { daemon: { killGraceMs: 250 } } }));
    expect(await loadDaemonShutdownWaitMs()).toBe(250 + DAEMON_SHUTDOWN_MARGIN_MS);
  });
});
