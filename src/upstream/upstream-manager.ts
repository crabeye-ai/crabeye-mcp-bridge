import type { BridgeConfig, ServerConfig, HttpServerConfig } from "../config/schema.js";
import { isStdioServer, resolveUpstreams } from "../config/schema.js";
import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";
import type { ToolRegistry } from "../server/tool-registry.js";
import { namespaceTool } from "../server/tool-namespacing.js";
import { HttpUpstreamClient } from "./http-client.js";
import { StdioUpstreamClient } from "./stdio-client.js";
import type { UpstreamClient, ConnectionStatus, HealthState } from "./types.js";

export interface UpstreamManagerOptions {
  config: BridgeConfig;
  toolRegistry: ToolRegistry;
  logger?: Logger;
  /** Health check interval in seconds. 0 to disable. Overrides config value. */
  healthCheckInterval?: number;
  /** Injectable client factory for testing. */
  _clientFactory?: (name: string, config: ServerConfig, logger: Logger) => UpstreamClient;
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

export interface ConnectAllResult {
  total: number;
  connected: number;
  failed: Array<{ name: string; error: string }>;
}

export class UpstreamManager {
  private _config: BridgeConfig;
  private _toolRegistry: ToolRegistry;
  private _logger: Logger;
  private _clientFactory: (name: string, config: ServerConfig, logger: Logger) => UpstreamClient;
  private _clients = new Map<string, UpstreamClient>();
  private _unsubscribers: Array<() => void> = [];
  private _healthCheckInterval: number;
  private _healthTimer: ReturnType<typeof setInterval> | undefined;
  private _healthTracking = new Map<string, HealthTracking>();
  private _pingsInFlight = new Set<string>();
  private _pingTimeoutMs = 5000;
  private _unhealthyThreshold = 3;

  constructor(options: UpstreamManagerOptions) {
    this._config = options.config;
    this._toolRegistry = options.toolRegistry;
    this._logger = options.logger ?? createNoopLogger();
    this._healthCheckInterval =
      options.healthCheckInterval ?? options.config._bridge.healthCheckInterval;
    this._clientFactory =
      options._clientFactory ??
      ((name, config, logger) => {
        if (isStdioServer(config)) {
          return new StdioUpstreamClient({ name, config, logger });
        }
        return new HttpUpstreamClient({ name, config: config as HttpServerConfig, logger });
      });
  }

  async connectAll(): Promise<ConnectAllResult> {
    const entries = Object.entries(resolveUpstreams(this._config));
    const connectPromises: Promise<{ name: string; error?: string }>[] = [];

    for (const [name, serverConfig] of entries) {
      const log = this._logger.child({ component: "upstream", server: name });
      const transport = isStdioServer(serverConfig)
        ? "stdio"
        : (serverConfig as HttpServerConfig).type;
      log.info(`connecting (${transport})`);

      const client = this._clientFactory(name, serverConfig, log);
      this._clients.set(name, client);

      const category = serverConfig._bridge?.category;
      if (category) {
        this._toolRegistry.setCategoryForSource(name, category);
      }

      const unsubTools = client.onToolsChanged((tools) => {
        const namespaced = tools.map((t) => namespaceTool(name, t));
        this._toolRegistry.setToolsForSource(name, namespaced);
        log.info(
          `${tools.length} tool${tools.length === 1 ? "" : "s"} discovered: ${namespaced.map((t) => t.name).join(", ")}`,
        );
      });

      const unsubStatus = client.onStatusChange((event) => {
        if (event.current === "error") {
          log.error(
            `error: ${event.error?.message ?? "unknown"}`,
          );
          this._toolRegistry.removeSource(name);
        } else {
          log.debug(`${event.current}`);
        }
      });

      this._unsubscribers.push(unsubTools, unsubStatus);

      connectPromises.push(
        client.connect().then(
          () => ({ name }),
          (err) => {
            const message = err instanceof Error ? err.message : String(err);
            log.error(`failed to connect: ${message}`);
            return { name, error: message };
          },
        ),
      );
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

    for (const unsub of this._unsubscribers) {
      unsub();
    }
    this._unsubscribers = [];

    const names = Array.from(this._clients.keys());

    const closePromises = Array.from(this._clients.values()).map((client) =>
      client.close().catch(() => {
        // Ignore close errors
      }),
    );
    await Promise.all(closePromises);

    for (const name of names) {
      this._toolRegistry.removeSource(name);
    }

    this._clients.clear();
    this._healthTracking.clear();
    this._pingsInFlight.clear();
  }

  getClient(name: string): UpstreamClient | undefined {
    return this._clients.get(name);
  }

  getStatuses(): UpstreamStatus[] {
    return Array.from(this._clients.values()).map((client) => {
      const tracking = this._healthTracking.get(client.name);
      return {
        name: client.name,
        status: client.status,
        health: tracking?.health ?? "unknown",
        toolCount: client.tools.length,
        lastPingAt: tracking?.lastPingAt,
      };
    });
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
    for (const [name, client] of this._clients) {
      if (client.status !== "connected") continue;
      if (this._pingsInFlight.has(name)) continue;

      let tracking = this._healthTracking.get(name);
      if (!tracking) {
        tracking = { consecutiveFailures: 0, health: "unknown" };
        this._healthTracking.set(name, tracking);
      }

      this._pingsInFlight.add(name);

      client.ping(this._pingTimeoutMs).then(
        () => {
          this._pingsInFlight.delete(name);
          const t = this._healthTracking.get(name);
          if (!t) return;
          const wasUnhealthy = t.health === "unhealthy";
          t.consecutiveFailures = 0;
          t.lastPingAt = Date.now();
          t.health = "healthy";
          if (wasUnhealthy) {
            this._logger.info("recovered", {
              component: "health",
              server: name,
            });
          }
        },
        (err) => {
          this._pingsInFlight.delete(name);
          const t = this._healthTracking.get(name);
          if (!t) return;
          t.consecutiveFailures++;
          t.health = "unhealthy";

          this._logger.warn("ping failed", {
            component: "health",
            server: name,
            error: err instanceof Error ? err.message : String(err),
            failures: t.consecutiveFailures,
          });

          if (t.consecutiveFailures >= this._unhealthyThreshold) {
            this._logger.error(
              `${t.consecutiveFailures} consecutive ping failures, reconnecting`,
              { component: "health", server: name },
            );
            t.consecutiveFailures = 0;
            t.health = "unknown";
            client.reconnect().catch((reconnectErr) => {
              this._logger.error("reconnect failed", {
                component: "health",
                server: name,
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
