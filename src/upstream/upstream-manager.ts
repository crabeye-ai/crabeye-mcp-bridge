import type { BridgeConfig, ServerConfig, HttpServerConfig } from "../config/schema.js";
import { isStdioServer, resolveUpstreams } from "../config/schema.js";
import type { ConfigDiff } from "../config/config-diff.js";
import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";
import type { ToolRegistry } from "../server/tool-registry.js";
import { namespaceTool } from "../server/tool-namespacing.js";
import { defaultClientFactory, type UpstreamClientFactory } from "./client-factory.js";
import type { UpstreamLink } from "./instance-link.js";
import { authorizationPausedMessage, type UpstreamClient } from "./types.js";

export type UpstreamManagerOptions = {
  config: BridgeConfig;
  toolRegistry: ToolRegistry;
  logger?: Logger;
} & (
  | {
      /** The bridge's link to its daemon instance, which connects every upstream. `closeAll` closes it. */
      instanceLink: UpstreamLink;
      _clientFactory?: undefined;
    }
  | {
      instanceLink?: undefined;
      /** Clients for tests to use instead of the daemon's. */
      _clientFactory: UpstreamClientFactory;
    }
);

interface Registered {
  client: UpstreamClient;
  /** Unsubscribe handles for tools/status listeners. */
  unsubscribers: Array<() => void>;
}

export interface ConnectAllResult {
  total: number;
  connected: number;
  failed: Array<{ name: string; error: string }>;
}

export class UpstreamManager {
  private _config: BridgeConfig;
  private _toolRegistry: ToolRegistry;
  private _logger: Logger;
  private _clientFactory: UpstreamClientFactory;
  private _clients = new Map<string, Registered>();
  private _instanceLink: UpstreamLink | undefined;
  private _clientsChangedListeners = new Set<() => void>();

  constructor(options: UpstreamManagerOptions) {
    this._config = options.config;
    this._toolRegistry = options.toolRegistry;
    this._logger = options.logger ?? createNoopLogger();
    this._instanceLink = options.instanceLink;

    this._clientFactory = options._clientFactory ?? defaultClientFactory(options.instanceLink);
  }

  private async _addClient(
    name: string,
    serverConfig: ServerConfig,
  ): Promise<{ name: string; error?: string }> {
    if (this._clients.has(name)) {
      // Already added (e.g. duplicate config key handled upstream).
      return { name };
    }

    const log = this._logger.child({ component: "upstream", server: name });
    const transport = isStdioServer(serverConfig)
      ? "stdio"
      : (serverConfig as HttpServerConfig).type;
    log.info(`connecting (${transport})`);

    return this._connect(this._register(name, serverConfig, log), name, log);
  }

  private _register(name: string, serverConfig: ServerConfig, log: Logger): Registered {
    const registered: Registered = { client: this._clientFactory(name), unsubscribers: [] };
    this._clients.set(name, registered);
    this._applyCategory(name, serverConfig);
    this._wireSubscriptions(name, registered, log);
    this._notifyClientsChanged();
    return registered;
  }

  private _applyCategory(name: string, serverConfig: ServerConfig): void {
    const category = serverConfig._bridge?.category;
    if (category) {
      this._toolRegistry.setCategoryForSource(name, category);
    } else {
      this._toolRegistry.removeCategoryForSource(name);
    }
  }

  private _wireSubscriptions(name: string, registered: Registered, log: Logger): void {
    const unsubTools = registered.client.onToolsChanged((tools) => {
      const namespaced = tools.map((t) => namespaceTool(name, t));
      this._toolRegistry.setToolsForSource(name, namespaced);
      // An upstream that spams `notifications/tools/list_changed` (some
      // buggy servers do this on every tool call) used to drive this
      // O(n) join on every fire, melting CPU when N is in the hundreds.
      // Info now reports the count only; the full list is debug-level.
      log.info(`${tools.length} tool${tools.length === 1 ? "" : "s"} discovered`);
      log.debug("discovered tools", { tools: namespaced.map((t) => t.name) });
    });

    let pauseLogged = false;
    const unsubStatus = registered.client.onStatusChange((event) => {
      if (event.current === "auth_required" && !pauseLogged) {
        pauseLogged = true;
        log.warn(authorizationPausedMessage(event.error));
        return;
      }
      if (event.current === "connected") pauseLogged = false;
      log.debug(`${event.current}`);
    });

    registered.unsubscribers.push(unsubTools, unsubStatus);
  }

  private async _connect(registered: Registered, name: string, log: Logger): Promise<{ name: string; error?: string }> {
    try {
      await registered.client.connect();
      return { name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`failed to connect: ${message}`);
      return { name, error: message };
    }
  }

  private async _removeClient(name: string): Promise<void> {
    const registered = this._clients.get(name);
    if (!registered) return;
    this._clients.delete(name);
    this._toolRegistry.removeSource(name);
    for (const unsub of registered.unsubscribers) unsub();
    await registered.client.close().catch(() => {});
  }

  async connectAll(): Promise<ConnectAllResult> {
    const entries = Object.entries(resolveUpstreams(this._config));
    const connectPromises: Promise<{ name: string; error?: string }>[] = [];

    for (const [name, serverConfig] of entries) {
      connectPromises.push(this._addClient(name, serverConfig));
    }

    const outcomes = await Promise.all(connectPromises);
    const failed = outcomes.filter((o) => o.error !== undefined) as Array<{ name: string; error: string }>;
    return {
      total: entries.length,
      connected: entries.length - failed.length,
      failed,
    };
  }

  async closeAll(): Promise<void> {
    const all = [...this._clients];
    this._clients.clear();
    for (const [, registered] of all) {
      for (const unsub of registered.unsubscribers) unsub();
    }
    await Promise.all(all.map(([, registered]) => registered.client.close().catch(() => {})));
    for (const [name] of all) this._toolRegistry.removeSource(name);
    await this._instanceLink?.close();
  }

  async applyConfigDiff(diff: ConfigDiff, newConfig: BridgeConfig): Promise<void> {
    // 1. Remove deleted servers
    for (const name of diff.servers.removed) {
      this._logger.info(`removing server`, { component: "reload", server: name });
      await this._removeClient(name);
      this._notifyClientsChanged();
    }

    // 2. Add new servers
    for (const { name, config } of diff.servers.added) {
      this._logger.info(`adding server`, { component: "reload", server: name });
      const result = await this._addClient(name, config);
      if (result.error) {
        this._logger.warn(`server failed to connect after reload`, {
          component: "reload", server: name, error: result.error,
        });
      }
    }

    // 3. Update changed servers
    for (const { name, config } of diff.servers.changed) {
      this._logger.info(`server changed`, { component: "reload", server: name });
      this._applyCategory(name, config);
    }

    this._config = newConfig;
  }

  /** Fires when a reload removes a server or a client is registered under a name; returns an unsubscribe. */
  onClientsChanged(listener: () => void): () => void {
    this._clientsChangedListeners.add(listener);
    return () => this._clientsChangedListeners.delete(listener);
  }

  private _notifyClientsChanged(): void {
    for (const listener of [...this._clientsChangedListeners]) listener();
  }

  getClient(name: string): UpstreamClient | undefined {
    return this._clients.get(name)?.client;
  }

  retryAuthPaused(): void {
    for (const { client } of this._clients.values()) {
      if (client.status === "auth_required") void client.retryNow();
    }
  }
}
