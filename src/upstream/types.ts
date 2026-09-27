import type { Tool, CallToolResult } from "@modelcontextprotocol/client";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

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

  /** Fresh reconnection: resets backoff, closes inner client, reconnects. */
  reconnect(): Promise<void>;

  onStatusChange(callback: StatusChangeCallback): () => void;
  onToolsChanged(callback: ToolsChangedCallback): () => void;
}
