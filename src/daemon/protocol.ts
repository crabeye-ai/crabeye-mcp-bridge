/**
 * Manager-daemon wire protocol.
 *
 * Frames: 4-byte big-endian uint32 length, followed by UTF-8 JSON payload.
 *
 * Three frame shapes (JSON-RPC 2.0 inspired):
 *   request:      { id, method, params? }       expects matching response
 *   response:     { id, result | error }        reply to request
 *   notification: { method, params? }           no `id`, no reply expected
 *
 * The frame envelope is the same across phases B → C → D; phase B adds
 * notification frames so daemon and bridge can pipe MCP JSON-RPC messages
 * over `RPC` notifications without a per-message ack roundtrip.
 */

export const PROTOCOL_VERSION = 1;

// 16 MiB hard cap. Daemon ↔ bridge messages are small JSON; anything larger is
// a protocol abuse and we want to fail fast rather than allocate.
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type DaemonMethod =
  | "STATUS"
  | "SHUTDOWN"
  | "OPEN"
  | "OPENED"
  | "RPC"
  | "CLOSE"
  | "RESTART"
  | "SESSION_EVICTED";

export interface DaemonRequest {
  id: string;
  method: DaemonMethod | string;
  params?: unknown;
}

export interface DaemonNotification {
  method: DaemonMethod | string;
  params?: unknown;
}

export interface DaemonError {
  code: string;
  message: string;
}

export interface DaemonResponse {
  id: string;
  result?: unknown;
  error?: DaemonError;
}

export type DaemonFrame = DaemonRequest | DaemonResponse | DaemonNotification;

/** Spec passed in `OPEN.params`. `cwd` is empty-string when the bridge has none. */
export interface OpenParams {
  sessionId: string;
  spec: {
    serverName: string;
    command: string;
    args: string[];
    resolvedEnv: Record<string, string>;
    cwd: string;
    sharing: "auto" | "shared" | "dedicated";
    clientInfo: { name: string; version: string };
    clientCapabilities: Record<string, unknown>;
    protocolVersion: string;
  };
}

export interface OpenResult {
  ok: true;
}

export interface CloseParams {
  sessionId: string;
}

export interface CloseResult {
  ok: true;
}

/**
 * RPC notification: bridge↔daemon transparent JSON-RPC pipe. `payload` is the
 * raw MCP JSON-RPC message (request, response, or notification) verbatim.
 */
export interface RpcNotificationParams {
  sessionId: string;
  payload: unknown;
}

export interface SessionEvictedParams {
  sessionId: string;
  reason: "auto_fork_initialize_failed" | "auto_fork_drain_timeout";
}

export interface StatusChild {
  pid: number;
  upstreamHash: string;
  startedAt: number;
  refcount: number;
  sessions: string[];
  subscriptionCount: number;
  mode: "shared" | "dedicated";
  sharing: "auto" | "shared" | "dedicated";
  forked: boolean;
  cachedInit: { protocolVersion: string } | null;
}

export interface StatusSession {
  sessionId: string;
  upstreamHash: string;
  serverName: string;
}

export interface StatusResult {
  uptime: number;
  pid: number;
  version: number;
  children: StatusChild[];
  sessions: StatusSession[];
}

// Typed error codes. Listed here so call sites and tests share the literal.
export const ERROR_CODE_INVALID_REQUEST = "invalid_request";
export const ERROR_CODE_UNKNOWN_METHOD = "unknown_method";
export const ERROR_CODE_NOT_IMPLEMENTED = "not_implemented";
export const ERROR_CODE_TOO_MANY_CONNECTIONS = "too_many_connections";
export const ERROR_CODE_RPC_TIMEOUT = "rpc_timeout";
export const ERROR_CODE_BACKPRESSURE = "backpressure";
export const ERROR_CODE_SESSION_NOT_FOUND = "session_not_found";
export const ERROR_CODE_SPAWN_FAILED = "spawn_failed";
export const ERROR_CODE_INVALID_PARAMS = "invalid_params";
export const ERROR_CODE_TOO_MANY_SESSIONS = "too_many_sessions";
/** Synthetic JSON-RPC error code emitted to inner requests when the session closes. */
export const INNER_ERROR_CODE_SESSION_CLOSED = -32000;
/** Synthetic JSON-RPC error code emitted when the per-child stdin queue overflows. */
export const INNER_ERROR_CODE_BACKPRESSURE = -32001;
/** Daemon-protocol-level error: failed to replay `initialize` against a forked child. */
export const ERROR_CODE_AUTO_FORK_INITIALIZE_FAILED = "auto_fork_initialize_failed";
/** Inner JSON-RPC error: drain window exceeded autoForkDrainTimeoutMs with old-child requests still pending. */
export const INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT = -32002;
/** Inner JSON-RPC error: per-session drain queue overflowed during fork. */
export const INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE = -32003;

const HEADER_BYTES = 4;

export function encodeFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf-8");
  if (json.byteLength > MAX_FRAME_BYTES) {
    throw new FrameError(
      `frame too large: ${json.byteLength} > ${MAX_FRAME_BYTES}`,
    );
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(json.byteLength, 0);
  return Buffer.concat([header, json]);
}

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameError";
  }
}

export class FrameDecoder {
  private chunks: Buffer[] = [];
  private size = 0;

  push(chunk: Buffer): void {
    // Bound the un-parsed buffer. A peer that drips bytes that never form a
    // valid header could otherwise grow this without limit.
    if (this.size + chunk.length > MAX_FRAME_BYTES + HEADER_BYTES) {
      this.chunks = [];
      this.size = 0;
      throw new FrameError("decoder buffer overflow");
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  next(): unknown | null {
    if (this.size < HEADER_BYTES) return null;
    const buf = this.coalesce();
    const len = buf.readUInt32BE(0);
    if (len > MAX_FRAME_BYTES) {
      // Discard the entire buffer so callers don't get stuck re-throwing on
      // every subsequent `next()`.
      this.chunks = [];
      this.size = 0;
      throw new FrameError(`frame too large: ${len} > ${MAX_FRAME_BYTES}`);
    }
    if (buf.length < HEADER_BYTES + len) return null;
    const payload = buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
    const rest = buf.subarray(HEADER_BYTES + len);
    this.chunks = rest.length === 0 ? [] : [rest];
    this.size = rest.length;
    try {
      return JSON.parse(payload.toString("utf-8"));
    } catch (err) {
      throw new FrameError(
        `invalid JSON payload: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private coalesce(): Buffer {
    if (this.chunks.length === 1) return this.chunks[0]!;
    const joined = Buffer.concat(this.chunks, this.size);
    this.chunks = [joined];
    return joined;
  }
}

export function notImplementedResponse(id: string, method: string): DaemonResponse {
  return {
    id,
    error: {
      code: ERROR_CODE_NOT_IMPLEMENTED,
      message: `method "${method}" is not implemented in this phase`,
    },
  };
}

/**
 * A frame is a notification when it has no `id` field (or `id` is null) AND
 * carries a `method`. Anything with `id + method` is a request; `id + result`
 * or `id + error` is a response. Frames missing both `id` and `method` are
 * malformed and should be rejected by the receiver.
 */
export function isNotification(frame: unknown): frame is DaemonNotification {
  if (typeof frame !== "object" || frame === null) return false;
  const f = frame as { id?: unknown; method?: unknown };
  if (f.id !== undefined && f.id !== null) return false;
  return typeof f.method === "string";
}

export function isRequest(frame: unknown): frame is DaemonRequest {
  if (typeof frame !== "object" || frame === null) return false;
  const f = frame as { id?: unknown; method?: unknown };
  return typeof f.id === "string" && typeof f.method === "string";
}

export function isResponse(frame: unknown): frame is DaemonResponse {
  if (typeof frame !== "object" || frame === null) return false;
  const f = frame as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
  if (typeof f.id !== "string") return false;
  if (typeof f.method === "string") return false;
  return f.result !== undefined || f.error !== undefined;
}
