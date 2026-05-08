import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

export interface BaseUpstreamClientOptions {
  name: string;
  logger?: Logger;
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
  /** Injectable transport factory for testing. */
  _transportFactory?: () => Transport;
}

export abstract class BaseUpstreamClient implements UpstreamClient {
  readonly name: string;

  private _status: ConnectionStatus = "disconnected";
  private _tools: Tool[] = [];
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
  protected _logger: Logger;
  protected _currentTransport: Transport | undefined;
  private _statusListeners = new Set<StatusChangeCallback>();
  private _toolsListeners = new Set<ToolsChangedCallback>();

  constructor(options: BaseUpstreamClientOptions) {
    this.name = options.name;
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

  get instructions(): string | undefined {
    return this._client?.getInstructions();
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
      this._currentTransport = undefined;
      await old.close().catch(() => {});
    }

    this._setStatus("connecting");
    this._logger.debug("connecting");

    try {
      await this._prepareConnect();
      const transport = this._createTransport();
      this._currentTransport = transport;
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
        this._currentTransport = undefined;
        this._onTransportClosed();
        this._setStatus("disconnected");
        this._scheduleReconnect();
      };

      await client.connect(transport);

      // Hook for subclasses to record per-connection state (e.g. spawned PID)
      // _before_ we make any further calls that could fail and leak the
      // subprocess. listTools() below can throw — if we record post-listTools
      // we lose the pid and can't reap on retry.
      await this._onTransportStarted(transport);

      const result = await client.listTools();
      this._tools = result.tools;
      this._client = client;
      if (this._reconnectAttempt > 0) {
        this._logger.info("reconnected", { attempts: this._reconnectAttempt });
      }
      this._reconnectAttempt = 0;
      this._setStatus("connected");
      this._afterConnect(transport);
      this._notifyToolsChanged();
    } catch (err) {
      this._logger.debug("connection failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Close the transport so we don't leak a spawned subprocess. SDK
      // Client.connect handles the case where initialize itself failed, but
      // if listTools() (or any other post-init step) throws, the transport
      // is still open and the subprocess is still running.
      const failed = this._currentTransport;
      this._currentTransport = undefined;
      if (failed) {
        await failed.close().catch(() => {});
      }
      this._onTransportClosed();
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
      this._currentTransport = undefined;
      await client.close();
    } else if (this._currentTransport) {
      // Race: shutdown fired while _doConnect was mid-flight (transport
      // started, _client not yet assigned). Close the transport directly so
      // the subprocess is killed.
      const transport = this._currentTransport;
      this._currentTransport = undefined;
      await transport.close().catch(() => {});
    }

    await this._onClose();

    this._tools = [];
    this._setStatus("disconnected");
  }

  async ping(timeoutMs = 5000): Promise<void> {
    if (!this._client || this._status !== "connected") {
      throw new Error(`Cannot ping: client "${this.name}" is not connected`);
    }
    await this._client.ping({ signal: AbortSignal.timeout(timeoutMs) });
  }

  async reconnect(): Promise<void> {
    this._reconnectAttempt = 0;
    this._closed = false;
    this._clearReconnectTimer();
    this._epoch++;

    if (this._client) {
      const old = this._client;
      this._client = undefined;
      await old.close().catch(() => {});
    }

    this._logger.info("reconnecting");
    await this.connect();
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
    return this._buildTransport();
  }

  /** Async hook called before transport creation in _doConnect(). Override for async setup. */
  protected async _prepareConnect(): Promise<void> {}

  /**
   * Async hook called immediately after `transport.start()` succeeds, before
   * the first request. Subclasses use this to record per-connection state
   * (e.g. spawned PID) so that any subsequent failure can still be cleaned up.
   */
  protected async _onTransportStarted(transport: Transport): Promise<void> {
    void transport;
  }

  /** Hook called after a successful connection. Override in subclasses for post-connect setup. */
  protected _afterConnect(transport: Transport): void {
    void transport;
  }

  /** Hook called when the transport closes (subprocess exit, peer disconnect, retry, etc). */
  protected _onTransportClosed(): void {}

  /** Hook called from close() so subclasses can release per-client resources. */
  protected async _onClose(): Promise<void> {}

  /** Subclasses create the real transport here. */
  protected abstract _buildTransport(): Transport;

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
    this._logger.info(`reconnecting in ${delay}ms`, { attempt: this._reconnectAttempt });

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
