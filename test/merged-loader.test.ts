import { describe, it, expect, afterEach } from "vitest";
import { chmod, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMergedConfig } from "../src/config/merged-loader.js";
import { ConfigError } from "../src/config/loader.js";

describe("loadMergedConfig", () => {
  const testDir = join(tmpdir(), `merged-loader-test-${process.pid}`);

  async function writeConfig(name: string, content: unknown): Promise<string> {
    await mkdir(testDir, { recursive: true });
    const p = join(testDir, name);
    await writeFile(p, JSON.stringify(content), "utf-8");
    return p;
  }

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("loads explicit --config override", async () => {
    const p = await writeConfig("explicit.json", {
      mcpServers: { svc: { command: "node" } },
    });

    const { config, watchPaths } = await loadMergedConfig({
      configOverridePath: p,
    });

    expect(config.mcpServers).toHaveProperty("svc");
    expect(watchPaths).toContain(p);
  });

  it("throws ConfigError for missing --config file", async () => {
    await expect(
      loadMergedConfig({ configOverridePath: join(testDir, "nope.json") }),
    ).rejects.toThrow(ConfigError);
  });

  it("throws ConfigError when no config found", async () => {
    // No bridge config, no --config
    await expect(loadMergedConfig()).rejects.toThrow(ConfigError);
    await expect(loadMergedConfig()).rejects.toThrow(/init/);
  });

  it("reads the bridge config at the given path instead of the one in the home directory, and watches it with the files it lists", async () => {
    const client = await writeConfig("client.json", { mcpServers: { svc: { url: "http://localhost:1/mcp" } } });
    const bridgeConfigPath = await writeConfig("config.json", { configPaths: [client] });

    const { config, watchPaths } = await loadMergedConfig({ bridgeConfigPath });

    expect(config.mcpServers).toHaveProperty("svc");
    expect(watchPaths).toEqual([bridgeConfigPath, client]);
  });

  it("leaves out a listed client file that isn't JSON, saying why and still watching it, and a missing one silently", async () => {
    const client = await writeConfig("client.json", { mcpServers: { svc: { url: "http://localhost:1/mcp" } } });
    const broken = join(testDir, "broken.json");
    await writeFile(broken, "{ not json", "utf-8");
    const bridgeConfigPath = await writeConfig("config.json", { configPaths: [client, broken, join(testDir, "gone.json")] });

    const { config, watchPaths, skipped } = await loadMergedConfig({ bridgeConfigPath });

    expect(Object.keys(config.mcpServers ?? {})).toEqual(["svc"]);
    expect(watchPaths).toEqual([bridgeConfigPath, client, broken]);
    expect(skipped).toEqual([{ path: broken, message: `Invalid JSON in config file: ${broken}` }]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("leaves out a listed client file it can't read, saying why and still watching it", async () => {
    const locked = await writeConfig("locked.json", { mcpServers: { svc: { url: "http://localhost:1/mcp" } } });
    await chmod(locked, 0o000);
    const bridgeConfigPath = await writeConfig("config.json", { configPaths: [locked] });

    const { watchPaths, skipped } = await loadMergedConfig({ bridgeConfigPath });

    expect(watchPaths).toEqual([bridgeConfigPath, locked]);
    expect(skipped).toEqual([{ path: locked, message: `Failed to read config file: ${locked} (EACCES)` }]);
  });

  it("names each invalid field of the merged config", async () => {
    const client = await writeConfig("client.json", { mcpServers: 5 });
    const bridgeConfigPath = await writeConfig("config.json", { configPaths: [client] });

    const error = await loadMergedConfig({ bridgeConfigPath }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues).toEqual([{ path: "mcpServers", message: "Invalid input: expected record, received number" }]);
  });

  it("throws ConfigError when the given bridge config doesn't exist", async () => {
    await expect(loadMergedConfig({ bridgeConfigPath: join(testDir, "missing.json") })).rejects.toThrow(ConfigError);
  });

  it("loads JSONC config file with comments", async () => {
    const content = `{
      // comment
      "mcpServers": {
        "svc": { "command": "node" }
      }
    }`;
    await mkdir(testDir, { recursive: true });
    const p = join(testDir, "jsonc.json");
    await writeFile(p, content, "utf-8");

    const { config } = await loadMergedConfig({ configOverridePath: p });
    expect(config.mcpServers).toHaveProperty("svc");
  });
});
