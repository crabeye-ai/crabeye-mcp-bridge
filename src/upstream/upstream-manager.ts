import type { BridgeConfig, ServerConfig, HttpServerConfig } from "../config/schema.js";
import { isStdioServer, resolveUpstreams } from "../config/schema.js";
import type { ConfigDiff } from "../config/config-diff.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";
import type { ToolRegistry } from "../server/tool-registry.js";
import { namespaceTool } from "../server/tool-namespacing.js";
import { defaultClientFactory, resolveStdioEnv, type UpstreamClientFactory } from "./client-factory.js";
import type { UpstreamLink } from "./instance-link.js";
import { InstanceUpstreamClient } from "./instance-upstream-client.js";
import { resolveReconnectInputs, upstreamHash } from "./upstream-hash.js";
import { HealthChecks } from "./health-checks.js";
import { authorizationPausedMessage, type UpstreamClient, type ConnectionStatus, type HealthState } from "./types.js";

export interface UpstreamManagerOptions {
  config: BridgeConfig;
  toolRegistry: ToolRegistry;
  logger?: Logger;
  credentialStore?: CredentialStore;
  /** Health check interval in seconds. 0 to disable. Overrides config value. */
  healthCheckInterval?: number;
  /** The bridge's link to its daemon instance, which connects the HTTP and SSE upstreams without `_bridge.auth`. `closeAll` closes it. */
  instanceLink?: UpstreamLink;
  /** Injectable client factory for testing. */
  _clientFactory?: UpstreamClientFactory;
}

export interface UpstreamStatus {
  name: string;
  status: ConnectionStatus;
  health: HealthState;
  toolCount: number;
  lastPingAt?: number;
}

interface ClientGroup {
  /** Underlying upstream client. Shared by every name in `aliasNames`. */
  client: UpstreamClient;
  /** STDIO upstream identity. `null` for HTTP groups (one client per name). */
  hash: string | null;
  /** Name first used to register this group; key in `_groups`. */
  primaryName: string;
  /** Names mapped to this client. Mutated as aliases attach/detach. */
  aliasNames: Set<string>;
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
  private _credentialStore: CredentialStore | undefined;
  private _clientFactory: UpstreamClientFactory;
  /** Every group, keyed by its primary name (the first alias added). */
  private _groups = new Map<string, ClientGroup>();
  /** Reverse index from any name (primary or alias) to its group. */
  private _nameToGroup = new Map<string, ClientGroup>();
  /** STDIO hash → group, used to dedupe identical specs to a single session. */
  private _stdioHashIndex = new Map<string, ClientGroup>();
  /**
   * Per-hash registration mutex. Concurrent `_addClient` calls for the same
   * hash (e.g. parallel `connectAll`) serialise here so the second caller
   * sees the first's group in `_stdioHashIndex` and aliases instead of
   * spawning a duplicate session.
   */
  private _hashLocks = new Map<string, Promise<void>>();
  private _registrations = new Map<string, Promise<void>>();
  private _health: HealthChecks;
  private _instanceLink: UpstreamLink | undefined;
  private _clientsChangedListeners = new Set<() => void>();

  constructor(options: UpstreamManagerOptions) {
    this._config = options.config;
    this._toolRegistry = options.toolRegistry;
    this._logger = options.logger ?? createNoopLogger();
    this._credentialStore = options.credentialStore;
    this._instanceLink = options.instanceLink;
    this._health = new HealthChecks({
      intervalSec: options.healthCheckInterval ?? options.config._bridge.healthCheckInterval,
      logger: this._logger,
    });

    this._clientFactory =
      options._clientFactory ??
      defaultClientFactory({
        bridgeConfig: () => this._config,
        credentialStore: options.credentialStore,
        instanceLink: options.instanceLink,
      });
  }

  whenRegistered(name: string): Promise<void> {
    return this._registrations.get(name) ?? Promise.resolve();
  }

  private async _addClient(
    name: string,
    serverConfig: ServerConfig,
  ): Promise<{ name: string; error?: string }> {
    if (this._nameToGroup.has(name)) {
      // Already added (e.g. duplicate config key handled upstream).
      return { name };
    }

    const log = this._logger.child({ component: "upstream", server: name });
    const transport = isStdioServer(serverConfig)
      ? "stdio"
      : (serverConfig as HttpServerConfig).type;
    log.info(`connecting (${transport})`);

    const registration = this._register(name, serverConfig, log);
    this._trackRegistration(name, registration);
    const registered = await registration;
    return "client" in registered ? this._connectGroup(registered, name, log) : registered;
  }

  private _trackRegistration(name: string, registration: Promise<unknown>): void {
    const settled = registration.then(
      () => {},
      () => {},
    );
    this._registrations.set(name, settled);
    void settled.then(() => {
      if (this._registrations.get(name) === settled) this._registrations.delete(name);
    });
  }

  private async _register(
    name: string,
    serverConfig: ServerConfig,
    log: Logger,
  ): Promise<ClientGroup | { name: string; error?: string }> {
    if (isStdioServer(serverConfig)) {
      let resolvedEnv: Record<string, string>;
      try {
        resolvedEnv = await resolveStdioEnv(serverConfig, this._credentialStore);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`failed to resolve credentials: ${message}`);
        return { name, error: message };
      }

      const reconnect = resolveReconnectInputs(this._config._bridge, serverConfig);
      const hash = upstreamHash({
        command: serverConfig.command,
        args: serverConfig.args ?? [],
        resolvedEnv,
        cwd: serverConfig.cwd ?? "",
        reconnect,
      });

      // Serialise concurrent registrations for the same hash so parallel
      // `connectAll` callers can't both miss the index and create duplicate
      // groups. Released in `finally`; the slow `connect()` runs after the
      // group is in the index, so other aliases find it without waiting.
      const inFlight = this._hashLocks.get(hash);
      if (inFlight) await inFlight;

      let release!: () => void;
      const lock = new Promise<void>((r) => {
        release = r;
      });
      this._hashLocks.set(hash, lock);

      let group: ClientGroup;
      try {
        const existing = this._stdioHashIndex.get(hash);
        if (existing !== undefined) {
          existing.aliasNames.add(name);
          this._nameToGroup.set(name, existing);
          this._notifyClientsChanged();
          this._applyCategory(name, serverConfig);
          const aliasOf = [...existing.aliasNames].filter((n) => n !== name).join(", ");
          this._logger.warn(
            `upstream "${name}" shares resolved spec hash ${hash.slice(0, 12)} with ${aliasOf}; sharing one daemon session`,
            { component: "upstream" },
          );
          if (existing.client.status === "connected") {
            const namespaced = existing.client.tools.map((t) => namespaceTool(name, t));
            this._toolRegistry.setToolsForSource(name, namespaced);
          }
          return { name };
        }

        // Construct the client first; only register it in the indices once
        // construction succeeds so a throwing factory cannot leave a
        // half-registered group that future aliases would attach to.
        let client: UpstreamClient;
        try {
          client = this._clientFactory(name, serverConfig, resolvedEnv, log);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error(`failed to construct client: ${message}`);
          return { name, error: message };
        }

        group = {
          client,
          hash,
          primaryName: name,
          aliasNames: new Set([name]),
          unsubscribers: [],
        };
        this._groups.set(name, group);
        this._nameToGroup.set(name, group);
        this._stdioHashIndex.set(hash, group);
        this._applyCategory(name, serverConfig);
        this._wireSubscriptions(group, log);
        this._health.add(client, name);
        this._notifyClientsChanged();
      } finally {
        release();
        if (this._hashLocks.get(hash) === lock) {
          this._hashLocks.delete(hash);
        }
      }

      return group;
    }

    // HTTP: one group per name. Same factory-throw protection as above.
    let client: UpstreamClient;
    try {
      client = this._clientFactory(name, serverConfig, {}, log);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`failed to construct client: ${message}`);
      return { name, error: message };
    }
    const group: ClientGroup = {
      client,
      hash: null,
      primaryName: name,
      aliasNames: new Set([name]),
      unsubscribers: [],
    };
    this._groups.set(name, group);
    this._nameToGroup.set(name, group);
    this._applyCategory(name, serverConfig);
    this._wireSubscriptions(group, log);
    if (!(client instanceof InstanceUpstreamClient)) this._health.add(client, name);
    this._notifyClientsChanged();
    return group;
  }

  private _applyCategory(name: string, serverConfig: ServerConfig): void {
    const category = serverConfig._bridge?.category;
    if (category) {
      this._toolRegistry.setCategoryForSource(name, category);
    }
  }

  private _wireSubscriptions(group: ClientGroup, log: Logger): void {
    const unsubTools = group.client.onToolsChanged((tools) => {
      for (const aliasName of group.aliasNames) {
        const namespaced = tools.map((t) => namespaceTool(aliasName, t));
        this._toolRegistry.setToolsForSource(aliasName, namespaced);
        // An upstream that spams `notifications/tools/list_changed` (some
        // buggy servers do this on every tool call) used to drive this
        // O(n) join on every fire, melting CPU when N is in the hundreds.
        // Info now reports the count only; the full list is debug-level.
        log.info(`${tools.length} tool${tools.length === 1 ? "" : "s"} discovered`);
        log.debug("discovered tools", { tools: namespaced.map((t) => t.name) });
      }
    });

    let pauseLogged = false;
    const unsubStatus = group.client.onStatusChange((event) => {
      if (event.current === "auth_required" && !pauseLogged) {
        pauseLogged = true;
        log.warn(authorizationPausedMessage(event.error));
        return;
      }
      if (event.current === "connected") pauseLogged = false;
      log.debug(`${event.current}`);
    });

    group.unsubscribers.push(unsubTools, unsubStatus);
  }

  private async _connectGroup(
    group: ClientGroup,
    name: string,
    log: Logger,
  ): Promise<{ name: string; error?: string }> {
    try {
      await group.client.connect();
      return { name };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`failed to connect: ${message}`);
      return { name, error: message };
    }
  }

  private async _removeClient(name: string): Promise<void> {
    const group = this._nameToGroup.get(name);
    if (!group) return;

    this._nameToGroup.delete(name);
    group.aliasNames.delete(name);
    this._toolRegistry.removeSource(name);

    if (group.aliasNames.size === 0) {
      // No more aliases — actually tear down the underlying client.
      for (const unsub of group.unsubscribers) unsub();
      group.unsubscribers = [];
      if (group.hash !== null) this._stdioHashIndex.delete(group.hash);
      this._groups.delete(group.primaryName);
      this._health.remove(group.client);
      await group.client.close().catch(() => {});
    }
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
    this.stopHealthChecks();

    for (const group of this._groups.values()) {
      for (const unsub of group.unsubscribers) unsub();
      group.unsubscribers = [];
      this._health.remove(group.client);
    }

    const allNames = Array.from(this._nameToGroup.keys());
    const uniqueClients = Array.from(this._groups.values()).map((g) => g.client);

    const closePromises = uniqueClients.map((client) =>
      client.close().catch(() => {
        // Ignore close errors
      }),
    );
    await Promise.all(closePromises);

    for (const name of allNames) {
      this._toolRegistry.removeSource(name);
    }

    this._groups.clear();
    this._nameToGroup.clear();
    this._stdioHashIndex.clear();
    await this._instanceLink?.close();
  }

  async applyConfigDiff(diff: ConfigDiff, newConfig: BridgeConfig): Promise<void> {
    // 1. Remove deleted servers
    for (const name of diff.servers.removed) {
      this._logger.info(`removing server`, { component: "reload", server: name });
      await this._removeClient(name);
      this._notifyClientsChanged();
    }

    // 2. Reconnect servers with changed connection fields
    for (const { name, config } of diff.servers.reconnect) {
      this._logger.info(`reconnecting server`, { component: "reload", server: name });
      await this._removeClient(name);
      const result = await this._addClient(name, config);
      if (!this._nameToGroup.has(name)) this._notifyClientsChanged();
      if (result.error) {
        this._logger.warn(`server failed to connect after reload`, {
          component: "reload", server: name, error: result.error,
        });
      }
    }

    // 3. Add new servers
    for (const { name, config } of diff.servers.added) {
      this._logger.info(`adding server`, { component: "reload", server: name });
      const result = await this._addClient(name, config);
      if (result.error) {
        this._logger.warn(`server failed to connect after reload`, {
          component: "reload", server: name, error: result.error,
        });
      }
    }

    // 4. Update metadata-only servers
    for (const { name, config } of diff.servers.updated) {
      this._logger.info(`updating metadata`, { component: "reload", server: name });
      const category = config._bridge?.category;
      if (category) {
        this._toolRegistry.setCategoryForSource(name, category);
      } else {
        this._toolRegistry.removeCategoryForSource(name);
      }
    }

    this._config = newConfig;
  }

  restartHealthChecks(interval: number): void {
    this._health.restart(interval);
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
    return this._nameToGroup.get(name)?.client;
  }

  getStatuses(): UpstreamStatus[] {
    const out: UpstreamStatus[] = [];
    for (const [name, group] of this._nameToGroup) {
      const { health, lastPingAt } = this._health.healthOf(group.client);
      out.push({
        name,
        status: group.client.status,
        health,
        toolCount: group.client.tools.length,
        lastPingAt,
      });
    }
    return out;
  }

  retryAuthPaused(): void {
    for (const group of new Set(this._nameToGroup.values())) {
      if (group.client.status === "auth_required") void group.client.retryNow();
    }
  }

  startHealthChecks(): void {
    this._health.start();
  }

  stopHealthChecks(): void {
    this._health.stop();
  }
}
