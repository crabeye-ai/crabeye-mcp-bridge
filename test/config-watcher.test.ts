import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, renameSync, rmSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigWatcher } from "../src/config/config-watcher.js";
import { spyLogger, type SpyLogger } from "./_helpers/spy-logger.js";

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

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

  function fileIn(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), "config-watcher-test-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, name);
    writeFileSync(path, "{}");
    return path;
  }

  function watcherOn(paths: string[], options: { debounceMs?: number; logger?: SpyLogger } = {}) {
    let changes = 0;
    const watcher = new ConfigWatcher({ configPaths: paths, debounceMs: options.debounceMs ?? 50, logger: options.logger });
    cleanups.push(() => watcher.stop());
    return { watcher, start: () => watcher.start(() => changes++), changes: () => changes };
  }

  /** Starts watching, then waits out the events macOS replays for writes made just before the watch began. */
  async function startedOn(paths: string[], options: { debounceMs?: number; logger?: SpyLogger } = {}) {
    const watched = watcherOn(paths, options);
    watched.start();
    await settle();
    const before = watched.changes();
    return { ...watched, since: () => watched.changes() - before };
  }

  it("calls back when a watched file changes", async () => {
    const configPath = fileIn("config.json");
    const { since } = await startedOn([configPath]);

    writeFileSync(configPath, '{"mcpServers":{}}');

    await waitFor(() => since() >= 1);
  });

  it("calls back once for a burst of edits", async () => {
    const configPath = fileIn("config.json");
    const { since } = await startedOn([configPath], { debounceMs: 100 });

    for (let i = 0; i < 5; i++) writeFileSync(configPath, JSON.stringify({ i }));

    await waitFor(() => since() >= 1);
    await settle(200);
    expect(since()).toBe(1);
  });

  it("calls back when an editor saves by renaming a new file over the watched one", async () => {
    const configPath = fileIn("config.json");
    const staged = join(dirname(configPath), "config.json.tmp");
    writeFileSync(staged, '{"mcpServers":{}}');
    const { since } = await startedOn([configPath]);

    renameSync(staged, configPath);

    await waitFor(() => since() >= 1);
  });

  it("ignores an edit to another file in the same directory", async () => {
    const configPath = fileIn("config.json");
    const sibling = join(dirname(configPath), "credentials.json");
    writeFileSync(sibling, "{}");
    const { since } = await startedOn([configPath]);

    writeFileSync(sibling, '{"other":true}');
    await settle();

    expect(since()).toBe(0);
  });

  it("doesn't call back after it stops", async () => {
    const configPath = fileIn("config.json");
    const { watcher, since } = await startedOn([configPath]);
    watcher.stop();

    writeFileSync(configPath, '{"mcpServers":{}}');
    await settle(200);

    expect(since()).toBe(0);
  });

  it("watches config files in several directories", async () => {
    const second = fileIn("config2.json");
    const { since } = await startedOn([fileIn("config1.json"), second]);

    writeFileSync(second, '{"mcpServers":{}}');

    await waitFor(() => since() >= 1);
  });

  it("warns about a directory it can't watch and still watches the others", async () => {
    const logger = spyLogger();
    const configPath = fileIn("config.json");
    const missing = join(dirname(configPath), "missing", "client.json");
    const { since } = await startedOn([missing, configPath], { logger });

    writeFileSync(configPath, '{"mcpServers":{}}');

    await waitFor(() => since() >= 1);
    expect(logger.warn).toHaveBeenCalledWith("failed to watch directory", expect.objectContaining({ path: join(dirname(configPath), "missing") }));
  });

  it("stops watching a directory whose watcher fails, logging why, instead of throwing", () => {
    const logger = spyLogger();
    const configPath = fileIn("config.json");
    const { watcher, start } = watcherOn([configPath], { logger });
    start();
    const [fsWatcher] = (watcher as unknown as { _watchers: FSWatcher[] })._watchers;

    expect(() => fsWatcher!.emit("error", new Error("EPERM: operation not permitted, watch"))).not.toThrow();

    expect(logger.warn).toHaveBeenCalledWith("stopped watching config directory", expect.objectContaining({ path: dirname(configPath), error: "EPERM: operation not permitted, watch" }));
    expect((watcher as unknown as { _watchers: FSWatcher[] })._watchers).toEqual([]);
  });
});
