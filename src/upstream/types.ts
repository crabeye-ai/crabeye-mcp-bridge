import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

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

  connect(): Promise<void>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<CallToolResult>;
  close(): Promise<void>;

  onStatusChange(callback: StatusChangeCallback): () => void;
  onToolsChanged(callback: ToolsChangedCallback): () => void;
}
