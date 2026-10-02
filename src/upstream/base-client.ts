import { Client } from "@modelcontextprotocol/client";
import type {
  Transport,
  Tool,
  CallToolResult,
  Implementation,
  ProtocolEra,
} from "@modelcontextprotocol/client";
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

const PROBE_TIMEOUT_MS = 10_000;
const STABLE_CONNECTION_MS = 60_000;

export function upstreamClientInfo(serverName: string): Implementation {
  return { name: `${APP_NAME}/${serverName}`, version: APP_VERSION };
}

export interface BaseUpstreamClientOptions {
  name: string;
  logger?: Logger;
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
  private _connectedAt = 0;
  private _lastAttemptEndedAt = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _reconnectBaseDelay: number;
  private _reconnectMaxDelay: number;
  private _transportFactory: (() => Transport) | undefined;
  protected _logger: Logger;
  protected _currentTransport: Transport | undefined;
  private _statusListeners = new Set<StatusChangeCallback>();
  private _toolsListeners = new Set<ToolsChangedCallback>();

  constructor(options: BaseUpstreamClientOptions) {
    this.name = options.name;
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

  protocolEra(): ProtocolEra | undefined {
    return this._client?.getProtocolEra();
  }

  get instructions(): string | undefined {
    return this._client?.getInstructions();
  }

  async connect(): Promise<void> {
    if (!this._connectPromise) {
      const attempt = this._doConnect().finally(() => {
        this._connectPromise = undefined;
        this._lastAttemptEndedAt = Date.now();
      });
      attempt.catch(() => {
        if (this._status === "disconnected") this._scheduleReconnect();
      });
      this._connectPromise = attempt;
    }
    return this._connectPromise;
  }

  async retryNow(): Promise<void> {
    if (this._closed || this._status === "connected") return;
    if (!this._connectPromise && !this._attemptedRecently()) {
      this._clearReconnectTimer();
      void this.connect().catch(() => {});
    }
    await this._connectPromise?.catch(() => {});
  }

  private _attemptedRecently(): boolean {
    return Date.now() - this._lastAttemptEndedAt < this._reconnectBaseDelay;
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
      this._abandonIfSuperseded(myEpoch);
      const transport = this._createTransport();
      this._currentTransport = transport;
      const client = new Client(
        upstreamClientInfo(this.name),
        {
          versionNegotiation: {
            mode: "auto",
            probe: { timeoutMs: PROBE_TIMEOUT_MS },
          },
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
        if (this._isSuperseded(myEpoch)) return;
        this._endConnection();
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
      if (this._isSuperseded(myEpoch)) {
        await client.close().catch(() => {});
        throw this._supersededError();
      }
      this._tools = result.tools;
      this._client = client;
      if (this._reconnectAttempt > 0) {
        this._logger.info("reconnected", { attempts: this._reconnectAttempt });
      }
      this._connectedAt = Date.now();
      this._logger.info("connected", { era: client.getProtocolEra() });
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
      this._setStatus(
        this._isAuthFailure(err) ? "auth_required" : "disconnected",
        err instanceof Error ? err : undefined,
      );
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
    const client = this._client;
    try {
      return (await client.callTool(params)) as CallToolResult;
    } catch (err) {
      this._pauseIfAuthFailure(client, err);
      throw err;
    }
  }

  async close(): Promise<void> {
    this._closed = true;
    this._connectedAt = 0;
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
    const signal = AbortSignal.timeout(timeoutMs);
    const client = this._client;
    try {
      if (client.getProtocolEra() === "modern") {
        await client.discover({ signal });
        return;
      }
      await client.ping({ signal });
    } catch (err) {
      this._pauseIfAuthFailure(client, err);
      throw err;
    }
  }

  async reconnect(): Promise<void> {
    await this._connectPromise?.catch(() => {});
    if (this._closed) return;
    this._endConnection();
    this._clearReconnectTimer();
    this._epoch++;

    if (this._client) {
      const old = this._client;
      this._client = undefined;
      await old.close().catch(() => {});
      if (this._closed) return;
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

  protected _isAuthFailure(err: unknown): boolean {
    void err;
    return false;
  }

  private _pauseIfAuthFailure(failedClient: Client, err: unknown): void {
    if (this._client !== failedClient || this._status !== "connected" || !this._isAuthFailure(err)) return;
    this._epoch++;
    this._endConnection();
    this._client = undefined;
    this._currentTransport = undefined;
    void failedClient.close().catch(() => {});
    this._onTransportClosed();
    this._setStatus("auth_required", err instanceof Error ? err : undefined);
  }

  private _endConnection(): void {
    if (this._connectedAt > 0 && Date.now() - this._connectedAt >= STABLE_CONNECTION_MS) {
      this._reconnectAttempt = 0;
    }
    this._connectedAt = 0;
  }

  private _isSuperseded(epoch: number): boolean {
    return this._closed || this._epoch !== epoch;
  }

  private _abandonIfSuperseded(epoch: number): void {
    if (this._isSuperseded(epoch)) throw this._supersededError();
  }

  private _supersededError(): Error {
    return new Error(`connection attempt for "${this.name}" was superseded`);
  }

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

    const delay = this._backoffDelay(this._reconnectAttempt);
    const alreadyAtCap = this._reconnectAttempt > 0 && this._backoffDelay(this._reconnectAttempt - 1) === delay;
    this._reconnectAttempt++;
    const message = `reconnecting in ${delay}ms`;
    const context = { attempt: this._reconnectAttempt };
    if (alreadyAtCap) this._logger.debug(message, context);
    else this._logger.info(message, context);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = undefined;
      this.connect().catch(() => {});
    }, delay);
  }

  private _backoffDelay(attempt: number): number {
    return Math.min(this._reconnectBaseDelay * Math.pow(2, attempt), this._reconnectMaxDelay);
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer !== undefined) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
  }
}
