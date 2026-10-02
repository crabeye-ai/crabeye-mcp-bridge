import type { Tool, CallToolResult } from "@modelcontextprotocol/client";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "auth_required";

export type HealthState = "unknown" | "healthy" | "unhealthy";

export interface StatusChangeEvent {
  previous: ConnectionStatus;
  current: ConnectionStatus;
  error?: Error;
}

export type StatusChangeCallback = (event: StatusChangeEvent) => void;
export type ToolsChangedCallback = (tools: ReadonlyArray<Tool>) => void;

export interface UpstreamClient {
  readonly name: string;
  readonly status: ConnectionStatus;
  readonly tools: ReadonlyArray<Tool>;
  /**
   * Upstream's `initialize.instructions` text, captured by the SDK Client when
   * the upstream completes its initialize handshake. `undefined` until
   * connected, or when the upstream did not advertise instructions.
   */
  readonly instructions?: string;

  connect(): Promise<void>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult>;
  close(): Promise<void>;

  ping(timeoutMs?: number): Promise<void>;

  /** Replaces the current connection; backoff resets only if that connection had been stable. */
  reconnect(): Promise<void>;

  /** Connects now instead of waiting out the backoff (throttled to the base delay); keeps the backoff level. */
  retryNow(): Promise<void>;

  onStatusChange(callback: StatusChangeCallback): () => void;
  onToolsChanged(callback: ToolsChangedCallback): () => void;
}
