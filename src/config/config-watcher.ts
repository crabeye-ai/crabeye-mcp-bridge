import { watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";
import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";
import { loadConfig } from "./loader.js";
import type { BridgeConfig } from "./schema.js";

export interface ConfigWatcherOptions {
  configPath: string;
  debounceMs?: number;
  logger?: Logger;
}

export class ConfigWatcher {
  private _configPath: string;
  private _debounceMs: number;
  private _logger: Logger;
  private _watcher: FSWatcher | undefined;
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _listener: ((config: BridgeConfig) => void | Promise<void>) | undefined;
  private _lastJson: string | undefined;
  private _reloading = false;
  private _pendingReload = false;

  constructor(options: ConfigWatcherOptions) {
    this._configPath = options.configPath;
    this._debounceMs = options.debounceMs ?? 500;
    this._logger = options.logger ?? createNoopLogger();
  }

  start(
    listener: (config: BridgeConfig) => void | Promise<void>,
    initialConfig?: BridgeConfig,
  ): void {
    if (this._watcher) return;

    this._listener = listener;

    if (initialConfig) {
      this._lastJson = JSON.stringify(initialConfig);
    }

    this._logger.debug("watching config file", {
      component: "config-watcher",
      path: this._configPath,
    });

    // Watch the directory — more reliable across platforms when files are
    // atomically replaced (write-to-temp + rename).
    const dir = dirname(this._configPath);
    const fileName = basename(this._configPath);

    this._watcher = watch(dir, (eventType, changedFile) => {
      // changedFile matches our config, or platform didn't provide a filename
      if (changedFile === fileName || (eventType === "rename" && !changedFile)) {
        this._scheduleReload();
      }
    });
  }

  stop(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = undefined;
    }
    if (this._watcher) {
      this._watcher.close();
      this._watcher = undefined;
    }
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

    loadConfig({ configPath: this._configPath }).then(
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
