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
 * Notification frames let daemon and bridge pipe MCP JSON-RPC messages over
 * `RPC` notifications without a per-message ack roundtrip.
 */

import type { Tool } from "@modelcontextprotocol/client";
import type { ConnectionStatus } from "../upstream/types.js";

export const PROTOCOL_VERSION = 3;
export const MIN_BRIDGE_PROTOCOL_VERSION = 1;
export const MIN_DAEMON_PROTOCOL_VERSION = 3;
export const UNREPORTED_BRIDGE_PROTOCOL_VERSION = 1;
export const STDERR_BRIDGE_PROTOCOL_VERSION = 2;
export const INSTANCE_BRIDGE_PROTOCOL_VERSION = 3;

// 16 MiB hard cap. Daemon ↔ bridge messages are small JSON; anything larger is
// a protocol abuse and we want to fail fast rather than allocate.
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Hard cap on requests in flight per session, and on tool calls in flight per attached bridge. */
export const MAX_INFLIGHT_PER_SESSION = 4096;

export const STDERR_LINE_MAX_CHARS = 1_000;
export const STDERR_TAIL_LINES = 20;
const STDERR_TRUNCATED_SUFFIX = " [truncated]";
export const STDERR_LINE_MAX_SENT_CHARS = STDERR_LINE_MAX_CHARS + STDERR_TRUNCATED_SUFFIX.length;

function isHighSurrogate(charCode: number): boolean {
  return charCode >= 0xd800 && charCode <= 0xdbff;
}

export function capStderrLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const cut = line.slice(0, maxChars);
  const whole = isHighSurrogate(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut;
  return whole + STDERR_TRUNCATED_SUFFIX;
}

export type DaemonMethod =
  | "STATUS"
  | "SHUTDOWN"
  | "OPEN"
  | "RPC"
  | "CLOSE"
  | "RESTART"
  | "PING"
  | "SESSION_EVICTED"
  | "STDERR"
  | "ATTACH"
  | "CALL_TOOL"
  | "CANCEL_TOOL"
  | "RETRY"
  | "UPSTREAM"
  | "UPSTREAM_REMOVED"
  | "LOG";

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

export const SHARING_FOR_OLDER_DAEMONS = "shared";

/** Spec passed in `OPEN.params`. `cwd` is empty-string when the bridge has none. */
export interface OpenParams {
  sessionId: string;
  bridgeProtocolVersion?: number;
  spec: {
    serverName: string;
    command: string;
    args: string[];
    resolvedEnv: Record<string, string>;
    cwd: string;
    sharing?: typeof SHARING_FOR_OLDER_DAEMONS;
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

export const CHILD_EXIT_CAUSES = ["exited", "failed_to_start", "unresponsive", "output_flood"] as const;

export interface ChildExit {
  cause: (typeof CHILD_EXIT_CAUSES)[number];
  code: number | null;
  signal: string | null;
}

export interface SessionEvictedParams {
  sessionId: string;
  reason: "child_exited" | "upstream_restarted";
  exit?: ChildExit;
  stderr?: string[];
}

export interface StderrParams {
  sessionId: string;
  line: string;
}

export interface StatusChild {
  pid: number;
  upstreamHash: string;
  serverName: string;
  era: ChildEraLabel;
  startedAt: number;
  refcount: number;
  sessions: string[];
  subscriptionCount: number;
  cachedInit: { protocolVersion: string } | null;
}

export interface StatusSession {
  sessionId: string;
  upstreamHash: string;
  serverName: string;
}

/**
 * The config a bridge would load: an explicit file, or the merged default
 * built from the bridge-owned `config.json` at `path`. Always absolute.
 */
export interface InstanceSource {
  kind: "file" | "merged";
  path: string;
}

/** `ATTACH.params`: joins the bridge's socket to the instance for `source` and `env`. */
export interface AttachParams {
  bridgeProtocolVersion: number;
  source: InstanceSource;
  /**
   * `MCP_BRIDGE_MASTER_KEY`, the variables a client-secret reference may name,
   * and the TLS and proxy variables, as the bridge's own Node process applies
   * them (see `instanceEnvFrom`).
   */
  env: Record<string, string>;
}

/** Sent after one `UPSTREAM` notification per name. */
export interface AttachResult {
  upstreams: string[];
}

/** Why a bridge can't use an upstream the daemon doesn't have. */
export function notInDaemonConfig(name: string): string {
  return `"${name}" is not in the configuration the manager loaded`;
}

/** Body of an `UPSTREAM` notification and of a `RETRY` reply. */
export interface UpstreamSnapshot {
  name: string;
  status: ConnectionStatus;
  /** Why the last connection attempt failed, while not connected. */
  error?: string;
  tools: Tool[];
  instructions?: string;
}

export interface CallToolParams {
  /** Chosen by the bridge, unique on its socket; `CANCEL_TOOL` names it. */
  callId: string;
  upstream: string;
  name: string;
  arguments?: Record<string, unknown>;
}

export interface CancelToolParams {
  callId: string;
}

export interface RetryParams {
  upstream: string;
}

export interface UpstreamRemovedParams {
  upstream: string;
}

export type UpstreamLogLevel = "warn" | "error";

export type UpstreamLogContext = Record<string, string | number | boolean>;

export interface UpstreamLogParams {
  upstream: string;
  level: UpstreamLogLevel;
  message: string;
  context?: UpstreamLogContext;
}

export interface StatusInstance {
  source: InstanceSource;
  bridges: number;
  upstreams: string[];
}

export interface StatusHttpUpstream {
  serverName: string;
  status: ConnectionStatus;
  instances: number;
}

export type {
  KilledReason as TelemetryKilledReason,
  TelemetrySnapshot,
} from "./telemetry.js";
import type { TelemetrySnapshot as _TelemetrySnapshot } from "./telemetry.js";
import type { ChildEraLabel } from "./child-era.js";

export interface StatusResult {
  uptime: number;
  pid: number;
  version: number;
  minBridgeProtocolVersion: number;
  appVersion: string;
  children: StatusChild[];
  sessions: StatusSession[];
  instances: StatusInstance[];
  httpUpstreams: StatusHttpUpstream[];
  telemetry: _TelemetrySnapshot;
}

export interface DaemonStatus {
  pid?: unknown;
  version?: unknown;
  appVersion?: unknown;
  minBridgeProtocolVersion?: unknown;
}

// Typed error codes. Listed here so call sites and tests share the literal.
export const ERROR_CODE_INVALID_REQUEST = "invalid_request";
export const ERROR_CODE_UNKNOWN_METHOD = "unknown_method";
export const ERROR_CODE_NOT_IMPLEMENTED = "not_implemented";
export const ERROR_CODE_TOO_MANY_CONNECTIONS = "too_many_connections";
export const ERROR_CODE_RPC_TIMEOUT = "rpc_timeout";
export const ERROR_CODE_BACKPRESSURE = "backpressure";
export const ERROR_CODE_SESSION_NOT_FOUND = "session_not_found";
export const ERROR_CODE_SESSION_IN_USE = "session_in_use";
export const ERROR_CODE_SPAWN_FAILED = "spawn_failed";
export const ERROR_CODE_INVALID_PARAMS = "invalid_params";
export const ERROR_CODE_TOO_MANY_SESSIONS = "too_many_sessions";
export const ERROR_CODE_DAEMON_STOPPING = "daemon_stopping";
export const ERROR_CODE_BRIDGE_UNSUPPORTED = "bridge_unsupported";
export const ERROR_CODE_INSTANCE_LOAD_FAILED = "instance_load_failed";
export const ERROR_CODE_UNKNOWN_UPSTREAM = "unknown_upstream";
export const ERROR_CODE_NOT_ATTACHED = "not_attached";
export const ERROR_CODE_ALREADY_ATTACHED = "already_attached";
export const ERROR_CODE_UPSTREAM_ERROR = "upstream_error";
export const ERROR_CODE_TOO_MANY_CALLS = "too_many_calls";
export const ERROR_CODE_TOO_MANY_INSTANCES = "too_many_instances";
export const ERROR_CODE_RESPONSE_TOO_LARGE = "response_too_large";
/** Synthetic JSON-RPC error code emitted to inner requests when the session closes. */
export const INNER_ERROR_CODE_SESSION_CLOSED = -32000;
/** Synthetic JSON-RPC error code emitted when the per-child stdin queue overflows. */
export const INNER_ERROR_CODE_BACKPRESSURE = -32001;
/** Daemon-protocol error: child was killed by an admin RESTART, or daemon was force-respawned. `data.reason` distinguishes the two. */
export const ERROR_CODE_UPSTREAM_RESTARTED = "upstream_restarted";
/** Inner JSON-RPC error: child was killed (admin RESTART or daemon respawn). MCP SDK requires numeric `code`; reason is carried in `data.reason`. */
export const INNER_ERROR_CODE_UPSTREAM_RESTARTED = -32004;

export type UpstreamRestartedReason = "admin_restart" | "daemon_respawn";

export interface RestartParams {
  upstreamHash: string;
}

export interface RestartResult {
  ok: true;
  /** How many child groups were killed. 0 means the hash was not registered (still ok=true). */
  killed: number;
}

export interface PingParams {
  /** Monotonically increasing seq from the sender. Echoed back in the PONG response. */
  seq: number;
}

export interface PingResult {
  seq: number;
  pid?: number;
}

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
    const len = this.header().readUInt32BE(0);
    if (len > MAX_FRAME_BYTES) {
      // Discard the entire buffer so callers don't get stuck re-throwing on
      // every subsequent `next()`.
      this.chunks = [];
      this.size = 0;
      throw new FrameError(`frame too large: ${len} > ${MAX_FRAME_BYTES}`);
    }
    if (this.size < HEADER_BYTES + len) return null;
    const buf = this.coalesce();
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

  private header(): Buffer {
    const first = this.chunks[0]!;
    return first.length >= HEADER_BYTES ? first : Buffer.concat(this.chunks, HEADER_BYTES);
  }

  private coalesce(): Buffer {
    if (this.chunks.length === 1) return this.chunks[0]!;
    const joined = Buffer.concat(this.chunks, this.size);
    this.chunks = [joined];
    return joined;
  }
}

export function errorResponse(id: string, code: string, message: string): DaemonResponse {
  return { id, error: { code, message } };
}

export function notImplementedResponse(id: string, method: string): DaemonResponse {
  return errorResponse(id, ERROR_CODE_NOT_IMPLEMENTED, `method "${method}" is not implemented in this phase`);
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
