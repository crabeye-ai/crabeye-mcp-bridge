import { watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";

export interface ConfigWatcherOptions {
  configPaths: string[];
  debounceMs?: number;
  logger?: Logger;
}

/** Calls back, once per burst of edits, when one of the config files changes. */
export class ConfigWatcher {
  private _configPaths: string[];
  private _debounceMs: number;
  private _logger: Logger;
  private _watchers: FSWatcher[] = [];
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _onChange: (() => void) | undefined;

  constructor(options: ConfigWatcherOptions) {
    this._configPaths = options.configPaths;
    this._debounceMs = options.debounceMs ?? 500;
    this._logger = options.logger ?? createNoopLogger();
  }

  start(onChange: () => void): void {
    if (this._watchers.length > 0) return;

    this._onChange = onChange;

    // Group paths by directory to create one watcher per directory
    const dirToFiles = new Map<string, Set<string>>();
    for (const configPath of this._configPaths) {
      const dir = dirname(configPath);
      const fileName = basename(configPath);
      if (!dirToFiles.has(dir)) {
        dirToFiles.set(dir, new Set());
      }
      dirToFiles.get(dir)!.add(fileName);
    }

    for (const [dir, fileNames] of dirToFiles) {
      this._logger.debug("watching config directory", {
        component: "config-watcher",
        path: dir,
        files: [...fileNames],
      });

      try {
        const watcher = watch(dir, (eventType, changedFile) => {
          if (
            (changedFile && fileNames.has(changedFile)) ||
            (eventType === "rename" && !changedFile)
          ) {
            this._scheduleChange();
          }
        });
        watcher.on("error", (err) => this._stopWatching(watcher, dir, err));
        this._watchers.push(watcher);
      } catch (err) {
        this._logger.warn("failed to watch directory", {
          component: "config-watcher",
          path: dir,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  stop(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    for (const watcher of this._watchers) {
      watcher.close();
    }
    this._watchers = [];
    this._onChange = undefined;
  }

  private _stopWatching(watcher: FSWatcher, dir: string, err: Error): void {
    watcher.close();
    this._watchers = this._watchers.filter((candidate) => candidate !== watcher);
    this._logger.warn("stopped watching config directory", {
      component: "config-watcher",
      path: dir,
      error: err.message,
    });
  }

  private _scheduleChange(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = undefined;
      this._onChange?.();
    }, this._debounceMs);
  }
}
