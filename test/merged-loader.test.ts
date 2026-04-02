import { describe, it, expect, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
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
