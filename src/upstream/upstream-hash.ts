import { createHash } from "node:crypto";
import type { GlobalBridgeConfig, ServerConfig } from "../config/schema.js";

/**
 * Reconnect knobs that materially change the client's runtime behavior. When
 * two upstream entries have identical specs but different reconnect settings,
 * they must not share a client — the second entry's settings would be silently
 * dropped because `BaseUpstreamClient` bakes them in at construction.
 */
export interface UpstreamReconnectInputs {
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
}

/**
 * Inputs to `upstreamHash`. `env` is the server's `env` as configured; `cwd`
 * is empty string when the upstream has no explicit working directory (the
 * daemon's own then applies).
 *
 * Hash inputs are deliberately narrow: only fields that, if changed, must
 * produce a different child process or surface different runtime behavior.
 * The environment of the client that starts the child is not in the hash, so
 * two clients started under different shells still share a child, and
 * neither is the server's name, so two names for the same spec share one.
 */
export interface UpstreamSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /**
   * Resolved reconnect settings. Included in the hash so two configs that
   * differ only in reconnect knobs get separate children instead of one
   * silently inheriting the other's settings.
   */
  reconnect?: UpstreamReconnectInputs;
}

/** The reconnect settings an upstream runs with: its own `_bridge.reconnect`, else the global one. */
export function resolveReconnectInputs(global: GlobalBridgeConfig, server: ServerConfig): UpstreamReconnectInputs {
  const own = server._bridge?.reconnect;
  return {
    reconnectBaseDelay: own?.reconnectBaseDelay ?? global.reconnect?.reconnectBaseDelay,
    reconnectMaxDelay: own?.reconnectMaxDelay ?? global.reconnect?.reconnectMaxDelay,
  };
}

/**
 * Stable, content-addressed identifier for an upstream child process.
 *
 * sha256 over a canonicalized JSON representation. Canonicalization sorts
 * object keys recursively so two equivalent specs produce the same hash
 * regardless of insertion order; arrays preserve order because argv is
 * positional.
 */
export function upstreamHash(spec: UpstreamSpec): string {
  const hashed: UpstreamSpec = {
    command: spec.command,
    args: spec.args,
    env: spec.env,
    cwd: spec.cwd,
  };
  if (spec.reconnect && hasAnyReconnectField(spec.reconnect)) {
    hashed.reconnect = {
      reconnectBaseDelay: spec.reconnect.reconnectBaseDelay,
      reconnectMaxDelay: spec.reconnect.reconnectMaxDelay,
    };
  }
  return createHash("sha256").update(canonicalize(hashed)).digest("hex");
}

function hasAnyReconnectField(r: UpstreamReconnectInputs): boolean {
  return (
    r.reconnectBaseDelay !== undefined ||
    r.reconnectMaxDelay !== undefined
  );
}

/** JSON with object keys sorted at every level, so equal values give equal text. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(JSON.stringify(key) + ":" + canonicalize(obj[key]));
  }
  return "{" + parts.join(",") + "}";
}
