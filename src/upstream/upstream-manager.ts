import type { BridgeConfig, ServerConfig, HttpServerConfig } from "../config/schema.js";
import { isStdioServer, resolveUpstreams } from "../config/schema.js";
import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";
import type { ToolRegistry } from "../server/tool-registry.js";
import { namespaceTool } from "../server/tool-namespacing.js";
import { HttpUpstreamClient } from "./http-client.js";
import { StdioUpstreamClient } from "./stdio-client.js";
import type { UpstreamClient, ConnectionStatus } from "./types.js";

export interface UpstreamManagerOptions {
  config: BridgeConfig;
  toolRegistry: ToolRegistry;
  logger?: Logger;
  /** Injectable client factory for testing. */
  _clientFactory?: (name: string, config: ServerConfig, logger: Logger) => UpstreamClient;
}

export interface UpstreamStatus {
  name: string;
  status: ConnectionStatus;
  toolCount: number;
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

  constructor(options: UpstreamManagerOptions) {
    this._config = options.config;
    this._toolRegistry = options.toolRegistry;
    this._logger = options.logger ?? createNoopLogger();
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
  }

  getClient(name: string): UpstreamClient | undefined {
    return this._clients.get(name);
  }

  getStatuses(): UpstreamStatus[] {
    return Array.from(this._clients.values()).map((client) => ({
      name: client.name,
      status: client.status,
      toolCount: client.tools.length,
    }));
  }
}
