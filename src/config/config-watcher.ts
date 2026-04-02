import { watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";
import type { BridgeConfig } from "./schema.js";

export interface ConfigWatcherOptions {
  configPaths: string[];
  loadConfig: () => Promise<BridgeConfig>;
  debounceMs?: number;
  logger?: Logger;
}

export class ConfigWatcher {
  private _configPaths: string[];
  private _loadConfig: () => Promise<BridgeConfig>;
  private _debounceMs: number;
  private _logger: Logger;
  private _watchers: FSWatcher[] = [];
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _listener: ((config: BridgeConfig) => void | Promise<void>) | undefined;
  private _lastJson: string | undefined;
  private _reloading = false;
  private _pendingReload = false;

  constructor(options: ConfigWatcherOptions) {
    this._configPaths = options.configPaths;
    this._loadConfig = options.loadConfig;
    this._debounceMs = options.debounceMs ?? 500;
    this._logger = options.logger ?? createNoopLogger();
  }

  start(
    listener: (config: BridgeConfig) => void | Promise<void>,
    initialConfig?: BridgeConfig,
  ): void {
    if (this._watchers.length > 0) return;

    this._listener = listener;

    if (initialConfig) {
      this._lastJson = JSON.stringify(initialConfig);
    }

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
            this._scheduleReload();
          }
        });
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
    this._listener = undefined;
    this._reloading = false;
    this._pendingReload = false;
  }

  private _scheduleReload(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = undefined;
      this._reload();
    }, this._debounceMs);
  }

  private _reload(): void {
    if (this._reloading) {
      this._pendingReload = true;
      return;
    }
    this._reloading = true;

    this._loadConfig().then(
      async (config) => {
        const json = JSON.stringify(config);
        if (json === this._lastJson) {
          this._logger.debug("config unchanged, skipping reload", {
            component: "config-watcher",
          });
          this._finishReload();
          return;
        }
        this._logger.info("config changed, reloading", {
          component: "config-watcher",
        });
        try {
          await this._listener?.(config);
          this._lastJson = json;
        } catch (err) {
          this._logger.error("reload listener threw", {
            component: "config-watcher",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        this._finishReload();
      },
      (err) => {
        this._logger.warn("failed to reload config", {
          component: "config-watcher",
          error: err instanceof Error ? err.message : String(err),
        });
        this._finishReload();
      },
    );
  }

  private _finishReload(): void {
    this._reloading = false;
    if (this._pendingReload) {
      this._pendingReload = false;
      this._reload();
    }
  }
}
