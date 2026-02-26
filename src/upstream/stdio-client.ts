import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StdioServerConfig } from "../config/schema.js";
import { APP_NAME, APP_VERSION } from "../constants.js";
import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";
import type {
  UpstreamClient,
  ConnectionStatus,
  StatusChangeEvent,
  StatusChangeCallback,
  ToolsChangedCallback,
} from "./types.js";

export interface StdioUpstreamClientOptions {
  name: string;
  config: StdioServerConfig;
  logger?: Logger;
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
  /** Injectable transport factory for testing. */
  _transportFactory?: () => Transport;
}

export class StdioUpstreamClient implements UpstreamClient {
  readonly name: string;

  private _status: ConnectionStatus = "disconnected";
  private _tools: Tool[] = [];
  private _config: StdioServerConfig;
  private _client: Client | undefined;
  private _closed = false;
  private _epoch = 0;
  private _connectPromise: Promise<void> | undefined;
  private _reconnectAttempt = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _maxReconnectAttempts: number;
  private _reconnectBaseDelay: number;
  private _reconnectMaxDelay: number;
  private _transportFactory: (() => Transport) | undefined;
  private _logger: Logger;
  private _statusListeners = new Set<StatusChangeCallback>();
  private _toolsListeners = new Set<ToolsChangedCallback>();

  constructor(options: StdioUpstreamClientOptions) {
    this.name = options.name;
    this._config = options.config;
    this._maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this._reconnectBaseDelay = options.reconnectBaseDelay ?? 1000;
    this._reconnectMaxDelay = options.reconnectMaxDelay ?? 30000;
    this._transportFactory = options._transportFactory;
    this._logger = options.logger ?? createNoopLogger();
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get tools(): ReadonlyArray<Tool> {
    return this._tools;
  }

  async connect(): Promise<void> {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._doConnect().finally(() => {
      this._connectPromise = undefined;
    });
    return this._connectPromise;
  }

  private async _doConnect(): Promise<void> {
    this._closed = false;
    this._clearReconnectTimer();
    this._epoch++;
    const myEpoch = this._epoch;

    // Clean up stale connection before creating a new one
    if (this._client) {
      const old = this._client;
      this._client = undefined;
      await old.close().catch(() => {});
    }

    this._setStatus("connecting");
    this._logger.debug("connecting");

    try {
      const transport = this._createTransport();
      const client = new Client(
        { name: `${APP_NAME}/${this.name}`, version: APP_VERSION },
        {
          listChanged: {
            tools: {
              autoRefresh: true,
              onChanged: (error, tools) => {
                if (error || !tools || this._epoch !== myEpoch) return;
                this._tools = tools;
                this._notifyToolsChanged();
              },
            },
          },
        },
      );

      transport.onclose = () => {
        if (this._closed || this._epoch !== myEpoch) return;
        this._client = undefined;
        this._setStatus("disconnected");
        this._scheduleReconnect();
      };

      await client.connect(transport);

      const result = await client.listTools();
      this._tools = result.tools;
      this._client = client;
      this._reconnectAttempt = 0;
      this._setStatus("connected");
      this._notifyToolsChanged();
    } catch (err) {
      this._logger.debug("connection failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this._setStatus("disconnected");
      throw err;
    }
  }

  async callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult> {
    if (!this._client || this._status !== "connected") {
      throw new Error(
        `Cannot call tool "${params.name}": client "${this.name}" is not connected`,
      );
    }
    return this._client.callTool(params) as Promise<CallToolResult>;
  }

  async close(): Promise<void> {
    this._closed = true;
    this._clearReconnectTimer();

    if (this._client) {
      const client = this._client;
      this._client = undefined;
      await client.close();
    }

    this._tools = [];
    this._setStatus("disconnected");
  }

  onStatusChange(callback: StatusChangeCallback): () => void {
    this._statusListeners.add(callback);
    return () => {
      this._statusListeners.delete(callback);
    };
  }

  onToolsChanged(callback: ToolsChangedCallback): () => void {
    this._toolsListeners.add(callback);
    return () => {
      this._toolsListeners.delete(callback);
    };
  }

  private _createTransport(): Transport {
    if (this._transportFactory) {
      return this._transportFactory();
    }

    const transport = new StdioClientTransport({
      command: this._config.command,
      args: this._config.args,
      env: { ...process.env, ...this._config.env } as Record<string, string>,
      stderr: "pipe",
    });

    // Forward subprocess stderr through the logger
    transport.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) {
        for (const line of text.split("\n")) {
          this._logger.debug(line, { stream: "stderr" });
        }
      }
    });

    return transport;
  }

  private _setStatus(next: ConnectionStatus, error?: Error): void {
    const previous = this._status;
    if (previous === next) return;
    this._status = next;

    const event: StatusChangeEvent = {
      previous,
      current: next,
      ...(error && { error }),
    };
    for (const listener of this._statusListeners) {
      try {
        listener(event);
      } catch {
        // Listeners must not throw
      }
    }
  }

  private _notifyToolsChanged(): void {
    for (const listener of this._toolsListeners) {
      try {
        listener(this._tools);
      } catch {
        // Listeners must not throw
      }
    }
  }

  private _scheduleReconnect(): void {
    if (this._closed) return;
    if (this._reconnectTimer !== undefined) return;
    if (this._connectPromise) return;

    if (this._reconnectAttempt >= this._maxReconnectAttempts) {
      this._logger.warn("max reconnect attempts reached");
      this._setStatus("error", new Error("Max reconnect attempts exceeded"));
      return;
    }

    const delay = Math.min(
      this._reconnectBaseDelay * Math.pow(2, this._reconnectAttempt),
      this._reconnectMaxDelay,
    );
    this._reconnectAttempt++;
    this._logger.debug(`reconnecting in ${delay}ms`, { attempt: this._reconnectAttempt });

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = undefined;
      this.connect().catch(() => {
        this._scheduleReconnect();
      });
    }, delay);
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
  }
}
