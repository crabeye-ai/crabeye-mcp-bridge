import { isAbsolute } from "node:path";
import { CERTIFICATE_FILE_ENV_NAMES, isInstanceEnvName } from "../instance-env.js";
import type { AttachParams, CallToolParams, CancelToolParams, InstanceSource, RetryParams } from "../protocol.js";

const MAX_PATH_BYTES = 4096;
const MAX_ENV_COUNT = 64;
const MAX_ENV_VALUE_BYTES = 65_536;
const MAX_CALL_ID_BYTES = 64;
const MAX_UPSTREAM_NAME_BYTES = 256;
const MAX_TOOL_NAME_BYTES = 1024;

export function parseAttachParams(raw: unknown): AttachParams | null {
  if (!isPlainObject(raw)) return null;
  const { bridgeProtocolVersion, source, env } = raw;
  if (typeof bridgeProtocolVersion !== "number" || !Number.isSafeInteger(bridgeProtocolVersion) || bridgeProtocolVersion < 1) return null;
  const parsedSource = parseSource(source);
  const parsedEnv = parseEnv(env);
  if (parsedSource === null || parsedEnv === null) return null;
  return { bridgeProtocolVersion, source: parsedSource, env: parsedEnv };
}

export function parseCallToolParams(raw: unknown): CallToolParams | null {
  if (!isPlainObject(raw)) return null;
  const { callId, upstream, name, arguments: args } = raw;
  if (!isBoundedString(callId, MAX_CALL_ID_BYTES) || !isUpstreamName(upstream) || !isBoundedString(name, MAX_TOOL_NAME_BYTES)) return null;
  if (args !== undefined && !isPlainObject(args)) return null;
  return { callId, upstream, name, ...(args !== undefined && { arguments: args }) };
}

export function parseRetryParams(raw: unknown): RetryParams | null {
  if (!isPlainObject(raw) || !isUpstreamName(raw.upstream)) return null;
  return { upstream: raw.upstream };
}

export function parseCancelToolParams(raw: unknown): CancelToolParams | null {
  if (!isPlainObject(raw) || !isBoundedString(raw.callId, MAX_CALL_ID_BYTES)) return null;
  return { callId: raw.callId };
}

function parseSource(raw: unknown): InstanceSource | null {
  if (!isPlainObject(raw)) return null;
  const { kind, path } = raw;
  if (kind !== "file" && kind !== "merged") return null;
  if (!isBoundedString(path, MAX_PATH_BYTES) || path.includes("\0") || !isAbsolute(path)) return null;
  return { kind, path };
}

function parseEnv(raw: unknown): Record<string, string> | null {
  if (!isPlainObject(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > MAX_ENV_COUNT) return null;
  const env: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!isInstanceEnvName(name)) return null;
    if (typeof value !== "string" || Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES || value.includes("\0")) return null;
    if (CERTIFICATE_FILE_ENV_NAMES.includes(name) && !isAbsolute(value)) return null;
    env[name] = value;
  }
  return env;
}

function isUpstreamName(value: unknown): value is string {
  return isBoundedString(value, MAX_UPSTREAM_NAME_BYTES);
}

function isBoundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maxBytes;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
