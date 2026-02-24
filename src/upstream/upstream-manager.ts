import type { BridgeConfig, ServerConfig, HttpServerConfig } from "../config/schema.js";
import { isStdioServer } from "../config/schema.js";
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

  async connectAll(): Promise<void> {
    const entries = Object.entries(this._config.mcpServers);
    const connectPromises: Promise<void>[] = [];

    for (const [name, serverConfig] of entries) {
      const client = this._clientFactory(name, serverConfig);
      this._clients.set(name, client);

      const unsubTools = client.onToolsChanged((tools) => {
        this._toolRegistry.setToolsForSource(
          name,
          tools.map((t) => namespaceTool(name, t)),
        );
      });

      const unsubStatus = client.onStatusChange((event) => {
        if (event.current === "error") {
          this._toolRegistry.removeSource(name);
        }
      });

      this._unsubscribers.push(unsubTools, unsubStatus);

      connectPromises.push(
        client.connect().catch(() => {
          // Individual failures must not block other connections
        }),
      );
    }

    await Promise.all(connectPromises);
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
