import type { Tool, CallToolResult } from "@modelcontextprotocol/client";

export const CONNECTION_STATUSES = ["disconnected", "connecting", "connected", "auth_required"] as const;

export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

const KNOWN_STATUSES: ReadonlySet<unknown> = new Set(CONNECTION_STATUSES);

/** The error of a connect abandoned because a reconnect or close replaced it. */
export class ConnectionSupersededError extends Error {
  constructor(serverName: string) {
    super(`connection attempt for "${serverName}" was superseded`);
    this.name = "ConnectionSupersededError";
  }
}

export function isConnectionStatus(value: unknown): value is ConnectionStatus {
  return KNOWN_STATUSES.has(value);
}

/** The warning for an upstream paused for authorization. */
export function authorizationPausedMessage(error: Error | undefined): string {
  return `authorization required; paused until the next call or reload: ${error?.message ?? "unknown"}`;
}

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
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<CallToolResult>;
  close(): Promise<void>;

  ping(timeoutMs?: number): Promise<void>;

  /** Replaces the current connection; backoff resets only if that connection had been stable. */
  reconnect(): Promise<void>;

  /** Connects now instead of waiting out the backoff (throttled to the base delay); keeps the backoff level. */
  retryNow(): Promise<void>;

  onStatusChange(callback: StatusChangeCallback): () => void;
  onToolsChanged(callback: ToolsChangedCallback): () => void;
}
