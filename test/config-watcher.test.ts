import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigWatcher } from "../src/config/config-watcher.js";
import { BridgeConfigSchema, type BridgeConfig } from "../src/config/schema.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "config-watcher-test-"));
}

function writeConfig(path: string, config: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(config));
}

function validConfig(servers: Record<string, unknown> = {}): Record<string, unknown> {
  return { mcpServers: servers };
}

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("ConfigWatcher", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const fn of cleanups) fn();
    cleanups.length = 0;
  });

  it("fires listener on config file change", async () => {
    const dir = makeTmpDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = join(dir, "config.json");
    const content = validConfig();
    writeConfig(configPath, content);

    const received: BridgeConfig[] = [];
    const watcher = new ConfigWatcher({ configPath, debounceMs: 50 });
    cleanups.push(() => watcher.stop());

    // Seed with initial config to avoid false positives from stale fs events
    watcher.start((config) => { received.push(config); }, BridgeConfigSchema.parse(content));

    // Give fs.watch time to fully initialize
    await new Promise((r) => setTimeout(r, 100));

    // Modify the config
    writeConfig(configPath, validConfig({
      linear: { type: "streamable-http", url: "http://localhost:3000" },
    }));

    await waitFor(() => received.length >= 1);
    expect(received[0].mcpServers).toHaveProperty("linear");
  });

  it("debounces rapid changes", async () => {
    const dir = makeTmpDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = join(dir, "config.json");
    const content = validConfig();
    writeConfig(configPath, content);

    const received: BridgeConfig[] = [];
    const watcher = new ConfigWatcher({ configPath, debounceMs: 100 });
    cleanups.push(() => watcher.stop());

    watcher.start((config) => { received.push(config); }, BridgeConfigSchema.parse(content));

    // Give fs.watch time to fully initialize
    await new Promise((r) => setTimeout(r, 100));

    // Rapid-fire 5 changes within debounce window
    for (let i = 0; i < 5; i++) {
      writeConfig(configPath, validConfig({
        [`server-${i}`]: { type: "streamable-http", url: `http://localhost:${3000 + i}` },
      }));
    }

    await waitFor(() => received.length >= 1);
    // Wait a bit more to confirm no additional calls
    await new Promise((r) => setTimeout(r, 200));

    // Should have fired only once (debounced)
    expect(received).toHaveLength(1);
  });

  it("skips reload when content is unchanged (seeded via initialConfig)", async () => {
    const dir = makeTmpDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = join(dir, "config.json");
    const content = validConfig({
      svc: { type: "streamable-http", url: "http://localhost:3000" },
    });
    writeConfig(configPath, content);

    const initialConfig = BridgeConfigSchema.parse(content);

    const received: BridgeConfig[] = [];
    const watcher = new ConfigWatcher({ configPath, debounceMs: 50 });
    cleanups.push(() => watcher.stop());

    // Seed _lastJson via initialConfig — no-op saves should be skipped
    watcher.start((config) => { received.push(config); }, initialConfig);

    // Give fs.watch time to fully initialize
    await new Promise((r) => setTimeout(r, 100));

    // Touch the file without changing content — should be skipped
    writeConfig(configPath, content);
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(0);

    // Actually change the content — should fire
    writeConfig(configPath, validConfig({
      svc: { type: "streamable-http", url: "http://localhost:4000" },
    }));
    await waitFor(() => received.length >= 1);
    expect(received).toHaveLength(1);
  });

  it("survives invalid JSON without crashing", async () => {
    const dir = makeTmpDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = join(dir, "config.json");
    const content = validConfig();
    writeConfig(configPath, content);

    const received: BridgeConfig[] = [];
    const watcher = new ConfigWatcher({ configPath, debounceMs: 50 });
    cleanups.push(() => watcher.stop());

    watcher.start((config) => { received.push(config); }, BridgeConfigSchema.parse(content));

    // Give fs.watch time to fully initialize
    await new Promise((r) => setTimeout(r, 100));

    // Write invalid JSON
    writeFileSync(configPath, "{bad json");
    await new Promise((r) => setTimeout(r, 200));

    // Should not have fired
    expect(received).toHaveLength(0);

    // Write valid config — should recover
    writeConfig(configPath, validConfig({
      svc: { type: "streamable-http", url: "http://localhost:3000" },
    }));
    await waitFor(() => received.length >= 1);
    expect(received).toHaveLength(1);
  });

  it("stop() prevents further notifications", async () => {
    const dir = makeTmpDir();
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = join(dir, "config.json");
    writeConfig(configPath, validConfig());

    const received: BridgeConfig[] = [];
    const watcher = new ConfigWatcher({ configPath, debounceMs: 50 });

    watcher.start((config) => { received.push(config); });
    watcher.stop();

    writeConfig(configPath, validConfig({
      svc: { type: "streamable-http", url: "http://localhost:3000" },
    }));
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toHaveLength(0);
  });
});
