/**
 * Manager-daemon wire protocol.
 *
 * Frames: 4-byte big-endian uint32 length, followed by UTF-8 JSON payload.
 * Payload: request `{ id, method, params? }` or response `{ id, result?, error? }`.
 *
 * Phase A defines the shape; only STATUS and SHUTDOWN are implemented. Other
 * methods return a `not_implemented` error so later phases can wire them in
 * without protocol churn.
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
  | "RESTART";

export interface DaemonRequest {
  id: string;
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

export interface StatusResult {
  uptime: number;
  pid: number;
  version: number;
  children: never[];
  sessions: never[];
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
      code: "not_implemented",
      message: `method "${method}" is not implemented in this phase`,
    },
  };
}
