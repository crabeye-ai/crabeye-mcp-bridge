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
 * Notification frames carry what needs no reply: upstream snapshots and
 * logs to bridges, and cancellations to the daemon.
 */

import type { Tool } from "@modelcontextprotocol/client";
import type { ConnectionStatus } from "../upstream/types.js";

export const PROTOCOL_VERSION = 4;
export const MIN_BRIDGE_PROTOCOL_VERSION = 4;
export const MIN_DAEMON_PROTOCOL_VERSION = 4;

// 16 MiB hard cap. Daemon ↔ bridge messages are small JSON; anything larger is
// a protocol abuse and we want to fail fast rather than allocate.
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Hard cap on tool calls in flight per attached bridge. */
export const MAX_CALLS_PER_BRIDGE = 4096;

export const STDERR_LINE_MAX_CHARS = 1_000;
export const STDERR_TAIL_LINES = 20;
const STDERR_TRUNCATED_SUFFIX = " [truncated]";

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
  | "RESTART"
  | "PING"
  | "ATTACH"
  | "CALL_TOOL"
  | "CANCEL_TOOL"
  | "RETRY"
  | "AUTH_CHANGED"
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

export type ChildEraLabel = "modern" | "legacy" | "unknown";

/** A STDIO server process the daemon runs. */
export interface StatusChild {
  pid: number;
  /** What `daemon restart-upstream` takes to restart it. */
  upstreamHash: string;
  serverName: string;
  era: ChildEraLabel;
  startedAt: number;
  /** How many instances use it. */
  instances: number;
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
  /** The bridge's environment for the STDIO servers the instance starts, without the master key (see `childEnvFrom`). */
  childEnv: Record<string, string>;
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

/** `AUTH_CHANGED.params`: the stored credentials of the upstreams named `upstream` changed. Needs no `ATTACH`. */
export interface AuthChangedParams {
  upstream: string;
}

/** Sent once every connection to those upstreams has tried to connect again. */
export interface AuthChangedResult {
  /** How many connections, across every instance, tried to connect again. */
  connections: number;
}

export type UpstreamLogLevel = "debug" | "warn" | "error";

export type UpstreamLogContext = Record<string, string | number | boolean>;

export interface UpstreamLogParams {
  upstream: string;
  level: UpstreamLogLevel;
  message: string;
  context?: UpstreamLogContext;
  /** The last lines a STDIO server wrote to stderr before it stopped, at most `STDERR_TAIL_LINES`. */
  stderr?: string[];
}

export interface StatusInstance {
  source: InstanceSource;
  bridges: number;
  upstreams: string[];
}

export type UpstreamType = "stdio" | "streamable-http" | "sse";

export type StatusUpstream = {
  serverName: string;
  status: ConnectionStatus;
  instances: number;
} & (
  | {
      type: "stdio";
      /** For RESTART, whether or not the server's process is running. */
      upstreamHash: string;
    }
  | { type: Exclude<UpstreamType, "stdio"> }
);

export type {
  KilledReason as TelemetryKilledReason,
  TelemetrySnapshot,
} from "./telemetry.js";
import type { TelemetrySnapshot as _TelemetrySnapshot } from "./telemetry.js";

export interface StatusResult {
  uptime: number;
  pid: number;
  version: number;
  minBridgeProtocolVersion: number;
  appVersion: string;
  children: StatusChild[];
  instances: StatusInstance[];
  upstreams: StatusUpstream[];
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
export const ERROR_CODE_TOO_MANY_CONNECTIONS = "too_many_connections";
export const ERROR_CODE_RPC_TIMEOUT = "rpc_timeout";
export const ERROR_CODE_INVALID_PARAMS = "invalid_params";
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

export interface RestartParams {
  upstreamHash: string;
}

export interface RestartResult {
  ok: true;
  /** How many STDIO servers were started again. 0 means none has that hash (still ok=true). */
  restarted: number;
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
