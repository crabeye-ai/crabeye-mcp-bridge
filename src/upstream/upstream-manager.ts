import type { BridgeConfig, ServerConfig, HttpServerConfig } from "../config/schema.js";
import { isStdioServer, resolveUpstreams } from "../config/schema.js";
import type { ToolRegistry } from "../server/tool-registry.js";
import { namespaceTool } from "../server/tool-namespacing.js";
import { HttpUpstreamClient } from "./http-client.js";
import { StdioUpstreamClient } from "./stdio-client.js";
import type { UpstreamClient, ConnectionStatus } from "./types.js";

export interface UpstreamManagerOptions {
  config: BridgeConfig;
  toolRegistry: ToolRegistry;
  /** Injectable client factory for testing. */
  _clientFactory?: (name: string, config: ServerConfig) => UpstreamClient;
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
  private _clientFactory: (name: string, config: ServerConfig) => UpstreamClient;
  private _clients = new Map<string, UpstreamClient>();
  private _unsubscribers: Array<() => void> = [];

  constructor(options: UpstreamManagerOptions) {
    this._config = options.config;
    this._toolRegistry = options.toolRegistry;
    this._clientFactory =
      options._clientFactory ??
      ((name, config) => {
        if (isStdioServer(config)) {
          return new StdioUpstreamClient({ name, config });
        }
        return new HttpUpstreamClient({ name, config: config as HttpServerConfig });
      });
  }

  async connectAll(): Promise<ConnectAllResult> {
    const entries = Object.entries(resolveUpstreams(this._config));
    const connectPromises: Promise<{ name: string; error?: string }>[] = [];

    for (const [name, serverConfig] of entries) {
      const transport = isStdioServer(serverConfig)
        ? "stdio"
        : (serverConfig as HttpServerConfig).type;
      this._log(`[${name}] connecting (${transport})`);

      const client = this._clientFactory(name, serverConfig);
      this._clients.set(name, client);

      const category = serverConfig._bridge?.category;
      if (category) {
        this._toolRegistry.setCategoryForSource(name, category);
      }

      const unsubTools = client.onToolsChanged((tools) => {
        const namespaced = tools.map((t) => namespaceTool(name, t));
        this._toolRegistry.setToolsForSource(name, namespaced);
        this._log(
          `[${name}] ${tools.length} tool${tools.length === 1 ? "" : "s"} discovered: ${namespaced.map((t) => t.name).join(", ")}`,
        );
      });

      const unsubStatus = client.onStatusChange((event) => {
        if (event.current === "error") {
          this._log(
            `[${name}] error: ${event.error?.message ?? "unknown"}`,
          );
          this._toolRegistry.removeSource(name);
        } else {
          this._log(`[${name}] ${event.current}`);
        }
      });

      this._unsubscribers.push(unsubTools, unsubStatus);

      connectPromises.push(
        client.connect().then(
          () => ({ name }),
          (err) => {
            const message = err instanceof Error ? err.message : String(err);
            this._log(`[${name}] failed to connect: ${message}`);
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

  private _log(message: string): void {
    console.error(message);
  }

  getStatuses(): UpstreamStatus[] {
    return Array.from(this._clients.values()).map((client) => ({
      name: client.name,
      status: client.status,
      toolCount: client.tools.length,
    }));
  }
}
