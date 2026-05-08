import type { BridgeConfig, ServerConfig, HttpServerConfig, StdioServerConfig, ReconnectConfig } from "../config/schema.js";
import { isStdioServer, resolveUpstreams } from "../config/schema.js";
import type { ConfigDiff } from "../config/config-diff.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import { resolveCredentialTemplates } from "../credentials/resolve-templates.js";
import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";
import type { ToolRegistry } from "../server/tool-registry.js";
import { namespaceTool } from "../server/tool-namespacing.js";
import { DaemonStdioClient } from "./daemon-stdio-client.js";
import { HttpUpstreamClient } from "./http-client.js";
import { upstreamHash, type UpstreamReconnectInputs } from "./upstream-hash.js";
import type { UpstreamClient, ConnectionStatus, HealthState } from "./types.js";

export interface UpstreamManagerOptions {
  config: BridgeConfig;
  toolRegistry: ToolRegistry;
  logger?: Logger;
  credentialStore?: CredentialStore;
  /** Health check interval in seconds. 0 to disable. Overrides config value. */
  healthCheckInterval?: number;
  /** Injectable client factory for testing. */
  _clientFactory?: (
    name: string,
    config: ServerConfig,
    resolvedEnv: Record<string, string>,
    logger: Logger,
  ) => UpstreamClient;
}

export interface UpstreamStatus {
  name: string;
  status: ConnectionStatus;
  health: HealthState;
  toolCount: number;
  lastPingAt?: number;
}

interface HealthTracking {
  consecutiveFailures: number;
  lastPingAt?: number;
  health: HealthState;
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
  private _clientFactory: (
    name: string,
    config: ServerConfig,
    resolvedEnv: Record<string, string>,
    logger: Logger,
  ) => UpstreamClient;
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
  private _healthCheckInterval: number;
  private _healthTimer: ReturnType<typeof setInterval> | undefined;
  /**
   * Health is tracked per underlying client (group), not per alias name. With
   * dedupe, multiple alias names share one client; keying by name lost
   * tracking when an alias was removed and reset `consecutiveFailures` to 0
   * the next tick (see AIT-246 review C3).
   */
  private _healthTracking = new WeakMap<ClientGroup, HealthTracking>();
  private _pingsInFlight = new WeakSet<ClientGroup>();
  private _pingTimeoutMs = 5000;
  private _unhealthyThreshold = 3;

  constructor(options: UpstreamManagerOptions) {
    this._config = options.config;
    this._toolRegistry = options.toolRegistry;
    this._logger = options.logger ?? createNoopLogger();
    this._credentialStore = options.credentialStore;
    this._healthCheckInterval =
      options.healthCheckInterval ?? options.config._bridge.healthCheckInterval;

    const credentialStore = options.credentialStore;
    this._clientFactory =
      options._clientFactory ??
      ((name, config, _resolvedEnv, logger) => {
        const reconnectOpts = this._reconnectInputsFor(config);
        if (isStdioServer(config)) {
          // Re-resolve env on every reconnect so a rotated credential reaches
          // the daemon-spawned child (matches HttpUpstreamClient behavior).
          const daemonCfg = this._config._bridge.daemon;
          return new DaemonStdioClient({
            name,
            config,
            logger,
            resolveEnv: () => this._resolveStdioEnv(config),
            rpcTimeoutMs: daemonCfg.rpcTimeoutMs,
            heartbeatMs: daemonCfg.heartbeatMs,
            respawnLockWaitMs: daemonCfg.respawnLockWaitMs,
            ...reconnectOpts,
          });
        }
        return new HttpUpstreamClient({
          name,
          config: config as HttpServerConfig,
          logger,
          credentialStore,
          ...reconnectOpts,
        });
      });
  }

  private _reconnectInputsFor(config: ServerConfig): UpstreamReconnectInputs {
    const globalReconnect = this._config._bridge.reconnect;
    const serverReconnect: ReconnectConfig | undefined = config._bridge?.reconnect;
    return {
      maxReconnectAttempts: serverReconnect?.maxReconnectAttempts ?? globalReconnect?.maxReconnectAttempts,
      reconnectBaseDelay: serverReconnect?.reconnectBaseDelay ?? globalReconnect?.reconnectBaseDelay,
      reconnectMaxDelay: serverReconnect?.reconnectMaxDelay ?? globalReconnect?.reconnectMaxDelay,
    };
  }

  private async _resolveStdioEnv(config: StdioServerConfig): Promise<Record<string, string>> {
    const env = (config.env ?? {}) as Record<string, string>;
    if (!this._credentialStore) return env;
    // resolveCredentialTemplates short-circuits per-value when no template
    // matches, so we don't need a pre-flight `hasCredentialTemplates` check.
    return resolveCredentialTemplates(env, this._credentialStore);
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

    if (isStdioServer(serverConfig)) {
      let resolvedEnv: Record<string, string>;
      try {
        resolvedEnv = await this._resolveStdioEnv(serverConfig);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`failed to resolve credentials: ${message}`);
        return { name, error: message };
      }

      const reconnect = this._reconnectInputsFor(serverConfig);
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
      } finally {
        release();
        if (this._hashLocks.get(hash) === lock) {
          this._hashLocks.delete(hash);
        }
      }

      return this._connectGroup(group, name, log);
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
    return this._connectGroup(group, name, log);
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
        log.info(
          `${tools.length} tool${tools.length === 1 ? "" : "s"} discovered: ${namespaced.map((t) => t.name).join(", ")}`,
        );
      }
    });

    const unsubStatus = group.client.onStatusChange((event) => {
      if (event.current === "error") {
        log.error(`error: ${event.error?.message ?? "unknown"}`);
        for (const aliasName of group.aliasNames) {
          this._toolRegistry.removeSource(aliasName);
        }
      } else {
        log.debug(`${event.current}`);
      }
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
      this._healthTracking.delete(group);
      this._pingsInFlight.delete(group);
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
    // _healthTracking and _pingsInFlight are WeakMap/WeakSet — entries drop
    // automatically once the ClientGroup objects above are unreferenced.
  }

  async applyConfigDiff(diff: ConfigDiff, newConfig: BridgeConfig): Promise<void> {
    // 1. Remove deleted servers
    for (const name of diff.servers.removed) {
      this._logger.info(`removing server`, { component: "reload", server: name });
      await this._removeClient(name);
    }

    // 2. Reconnect servers with changed connection fields
    for (const { name, config } of diff.servers.reconnect) {
      this._logger.info(`reconnecting server`, { component: "reload", server: name });
      await this._removeClient(name);
      const result = await this._addClient(name, config);
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
    this.stopHealthChecks();
    this._healthCheckInterval = interval;
    this.startHealthChecks();
  }

  getClient(name: string): UpstreamClient | undefined {
    return this._nameToGroup.get(name)?.client;
  }

  getStatuses(): UpstreamStatus[] {
    const out: UpstreamStatus[] = [];
    for (const [name, group] of this._nameToGroup) {
      const tracking = this._healthTracking.get(group);
      out.push({
        name,
        status: group.client.status,
        health: tracking?.health ?? "unknown",
        toolCount: group.client.tools.length,
        lastPingAt: tracking?.lastPingAt,
      });
    }
    return out;
  }

  startHealthChecks(): void {
    if (this._healthCheckInterval <= 0) return;
    if (this._healthTimer) return;

    this._logger.debug("starting health checks", {
      component: "health",
      interval: this._healthCheckInterval,
    });

    this._healthTimer = setInterval(() => {
      this._runHealthCheck();
    }, this._healthCheckInterval * 1000);
  }

  stopHealthChecks(): void {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = undefined;
    }
  }

  private _runHealthCheck(): void {
    // Iterate unique groups so a deduped client is pinged once per tick. The
    // tracking entry is keyed by the group itself (not by alias name), so
    // removing one alias does not lose the failure counter for the others.
    const seen = new Set<ClientGroup>();
    for (const group of this._nameToGroup.values()) {
      if (seen.has(group)) continue;
      seen.add(group);
      if (group.client.status !== "connected") continue;
      if (this._pingsInFlight.has(group)) continue;

      let tracking = this._healthTracking.get(group);
      if (!tracking) {
        tracking = { consecutiveFailures: 0, health: "unknown" };
        this._healthTracking.set(group, tracking);
      }

      const logServer = group.primaryName;
      this._pingsInFlight.add(group);

      group.client.ping(this._pingTimeoutMs).then(
        () => {
          this._pingsInFlight.delete(group);
          const t = this._healthTracking.get(group);
          if (!t) return;
          const wasUnhealthy = t.health === "unhealthy";
          t.consecutiveFailures = 0;
          t.lastPingAt = Date.now();
          t.health = "healthy";
          if (wasUnhealthy) {
            this._logger.info("recovered", { component: "health", server: logServer });
          }
        },
        (err) => {
          this._pingsInFlight.delete(group);
          const t = this._healthTracking.get(group);
          if (!t) return;
          t.consecutiveFailures++;
          t.health = "unhealthy";

          this._logger.warn("ping failed", {
            component: "health",
            server: logServer,
            error: err instanceof Error ? err.message : String(err),
            failures: t.consecutiveFailures,
          });

          if (t.consecutiveFailures >= this._unhealthyThreshold) {
            this._logger.error(
              `${t.consecutiveFailures} consecutive ping failures, reconnecting`,
              { component: "health", server: logServer },
            );
            t.consecutiveFailures = 0;
            t.health = "unknown";
            group.client.reconnect().catch((reconnectErr) => {
              this._logger.error("reconnect failed", {
                component: "health",
                server: logServer,
                error:
                  reconnectErr instanceof Error
                    ? reconnectErr.message
                    : String(reconnectErr),
              });
            });
          }
        },
      );
    }
  }
}
