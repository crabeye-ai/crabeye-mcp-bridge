import type { LogLevel } from "../logging/index.js";
import type { DescriptionParams, SearchToolsResult, SettingsParams, UpstreamLogParams, UpstreamRemovedParams, UpstreamSnapshot } from "../daemon/protocol.js";
import { isConnectionStatus } from "./types.js";

/** The snapshot in `value`, or null when it isn't one; a status this bridge doesn't know reads as disconnected. */
export function snapshotOf(value: unknown): UpstreamSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, status, tools } = value as { name?: unknown; status?: unknown; tools?: unknown };
  if (typeof name !== "string" || typeof status !== "string" || !Array.isArray(tools)) return null;
  if (isConnectionStatus(status)) return value as UpstreamSnapshot;
  return { name, status: "disconnected", error: `the manager reported a status this bridge doesn't know: ${status}`, tools: [] };
}

export function isRemoval(value: unknown): value is UpstreamRemovedParams {
  return typeof value === "object" && value !== null && typeof (value as Partial<UpstreamRemovedParams>).upstream === "string";
}

/** The log line in `value`, or null when it isn't one; a level this bridge doesn't know logs at debug. */
export function logOf(value: unknown): UpstreamLogParams | null {
  if (typeof value !== "object" || value === null) return null;
  const { upstream, level, message, stderr } = value as Partial<Record<keyof UpstreamLogParams, unknown>>;
  if (stderr !== undefined && !(Array.isArray(stderr) && stderr.every((line) => typeof line === "string"))) return null;
  if ((upstream !== undefined && typeof upstream !== "string") || typeof message !== "string") return null;
  return { ...(value as UpstreamLogParams), level: isLogLevel(level) ? level : "debug" };
}

export function isSettings(value: unknown): value is SettingsParams {
  return typeof value === "object" && value !== null && isLogLevel((value as { logLevel?: unknown }).logLevel);
}

export function isLogLevel(value: unknown): value is LogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error";
}

export function isSearchResult(value: unknown): value is SearchToolsResult {
  return typeof value === "object" && value !== null && Array.isArray((value as { results?: unknown }).results);
}

export function isDescription(value: unknown): value is DescriptionParams {
  return typeof value === "object" && value !== null && typeof (value as { text?: unknown }).text === "string";
}
