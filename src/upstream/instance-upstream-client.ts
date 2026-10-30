import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { notInDaemonConfig, type UpstreamSnapshot } from "../daemon/protocol.js";
import { canonicalize } from "./upstream-hash.js";
import type { UpstreamLink } from "./instance-link.js";
import type {
  ConnectionStatus,
  StatusChangeCallback,
  StatusChangeEvent,
  ToolsChangedCallback,
  UpstreamClient,
} from "./types.js";

export interface InstanceUpstreamClientOptions {
  name: string;
  link: UpstreamLink;
}

/**
 * Stands in for an upstream the daemon connects: mirrors the state, tools
 * and instructions the daemon reports and sends calls through the bridge's
 * instance link. The daemon reconnects and health-checks the upstream.
 */
export class InstanceUpstreamClient implements UpstreamClient {
  readonly name: string;
  private readonly _link: UpstreamLink;
  private readonly _unwatch: () => void;
  private readonly _statusListeners = new Set<StatusChangeCallback>();
  private readonly _toolsListeners = new Set<ToolsChangedCallback>();
  private _status: ConnectionStatus = "disconnected";
  private _tools: Tool[] = [];
  private _toolsText = canonicalize([]);
  private _instructions: string | undefined;
  private _lastError: Error | undefined;
  private _closed = false;

  constructor(options: InstanceUpstreamClientOptions) {
    this.name = options.name;
    this._link = options.link;
    this._unwatch = this._link.watch(this.name, {
      onSnapshot: (snapshot) => this._apply(snapshot),
      onRemoved: () => this._setStatus("disconnected", new Error(notInDaemonConfig(this.name))),
      onInterrupted: () => this._setStatus("connecting"),
      onDown: (error) => this._setStatus("disconnected", error),
    });
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get tools(): ReadonlyArray<Tool> {
    return this._tools;
  }

  get instructions(): string | undefined {
    return this._instructions;
  }

  /** Settles once the daemon has tried the upstream: resolves when connected, rejects with the reason otherwise. */
  async connect(): Promise<void> {
    if (this._closed) throw new Error(`client "${this.name}" is closed`);
    await this._link.attach();
    const known = this._link.snapshot(this.name);
    if (known !== undefined) this._apply(known);
    if (this._status !== "connected") {
      this._setStatus("connecting");
      await this._retry();
      if (this._status === "connecting") await this._settled();
    }
    if (this._status !== "connected") throw this._lastError ?? new Error(`upstream "${this.name}" is ${this._status}`);
  }

  async retryNow(): Promise<void> {
    if (!this._wantsRetry()) return;
    if (!this._link.isAttached) {
      await this._link.attachNow().catch(() => {});
      if (!this._link.isAttached || !this._wantsRetry()) return;
    }
    this._setStatus("connecting");
    await this._retry().catch(() => {});
  }

  /** Never replaces the shared connection; asks the daemon to retry it instead. */
  reconnect(): Promise<void> {
    return this.retryNow();
  }

  async ping(): Promise<void> {
    if (this._status !== "connected") throw new Error(`Cannot ping: client "${this.name}" is not connected`);
  }

  async callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<CallToolResult> {
    if (this._status !== "connected") {
      throw new Error(`Cannot call tool "${params.name}": client "${this.name}" is not connected`);
    }
    return this._link.callTool(this.name, params, options?.signal);
  }

  async close(): Promise<void> {
    this._closed = true;
    this._unwatch();
    this._tools = [];
    this._toolsText = canonicalize([]);
    this._setStatus("disconnected");
  }

  onStatusChange(callback: StatusChangeCallback): () => void {
    this._statusListeners.add(callback);
    return () => this._statusListeners.delete(callback);
  }

  onToolsChanged(callback: ToolsChangedCallback): () => void {
    this._toolsListeners.add(callback);
    return () => this._toolsListeners.delete(callback);
  }

  private _wantsRetry(): boolean {
    return !this._closed && this._status !== "connected";
  }

  private async _retry(): Promise<void> {
    try {
      await this._link.retry(this.name);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this._setStatus("disconnected", error);
      throw error;
    }
  }

  private _settled(): Promise<void> {
    return new Promise((resolve) => {
      const unsubscribe = this.onStatusChange((event) => {
        if (event.current === "connecting") return;
        unsubscribe();
        resolve();
      });
    });
  }

  private _apply(snapshot: UpstreamSnapshot): void {
    if (this._closed) return;
    const connected = snapshot.status === "connected";
    const becameConnected = connected && this._status !== "connected";
    const toolsText = connected ? canonicalize(snapshot.tools) : this._toolsText;
    const toolsChanged = toolsText !== this._toolsText;
    this._instructions = snapshot.instructions;
    if (toolsChanged) {
      this._tools = snapshot.tools;
      this._toolsText = toolsText;
    }
    this._setStatus(snapshot.status, snapshot.error === undefined ? undefined : new Error(snapshot.error));
    if (toolsChanged || becameConnected) this._notifyTools();
  }

  private _setStatus(next: ConnectionStatus, error?: Error): void {
    if (this._closed && next !== "disconnected") return;
    if (next === "connected") this._lastError = undefined;
    else if (error !== undefined) this._lastError = error;
    const previous = this._status;
    if (previous === next) return;
    this._status = next;
    const event: StatusChangeEvent = { previous, current: next, ...(error && { error }) };
    for (const listener of [...this._statusListeners]) {
      try {
        listener(event);
      } catch {
        // ignore
      }
    }
  }

  private _notifyTools(): void {
    for (const listener of [...this._toolsListeners]) {
      try {
        listener(this._tools);
      } catch {
        // ignore
      }
    }
  }
}
