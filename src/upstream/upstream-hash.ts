import { createHash } from "node:crypto";

/**
 * Reconnect knobs that materially change the client's runtime behavior. When
 * two upstream entries have identical specs but different reconnect settings,
 * we must NOT collapse them — the second alias's settings would be silently
 * dropped because `BaseUpstreamClient` bakes them in at construction.
 */
export interface UpstreamReconnectInputs {
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
  reconnectMaxDelay?: number;
}

/**
 * Inputs to `upstreamHash`. `resolvedEnv` is the env after credential-template
 * expansion on the bridge side; `cwd` is empty string when the upstream has
 * no explicit working directory (daemon will inherit its own).
 *
 * Hash inputs are deliberately narrow: only fields that, if changed, must
 * produce a different child process or surface different runtime behavior.
 * The daemon's own `process.env` is NOT in the hash so two bridges started
 * under different shells still share a child in phase C.
 *
 * `serverName` is intentionally **not** part of the hash. Two upstreams
 * mounted under different names that resolve to the same spec collapse to a
 * single child (with a warning at the bridge layer); the daemon treats them
 * as the same identity for sharing in phase C.
 */
export interface UpstreamSpec {
  /**
   * Logical name used by the bridge for diagnostics and alias logging. Not
   * part of the hash — see comment above.
   */
  serverName?: string;
  command: string;
  args: string[];
  resolvedEnv: Record<string, string>;
  cwd: string;
  /**
   * Resolved reconnect settings. Included in the hash so two configs that
   * differ only in reconnect knobs produce separate sessions instead of one
   * silently inheriting the other's settings.
   */
  reconnect?: UpstreamReconnectInputs;
}

interface HashedUpstreamSpec {
  command: string;
  args: string[];
  resolvedEnv: Record<string, string>;
  cwd: string;
  reconnect?: UpstreamReconnectInputs;
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
  const hashed: HashedUpstreamSpec = {
    command: spec.command,
    args: spec.args,
    resolvedEnv: spec.resolvedEnv,
    cwd: spec.cwd,
  };
  if (spec.reconnect && hasAnyReconnectField(spec.reconnect)) {
    hashed.reconnect = spec.reconnect;
  }
  return createHash("sha256").update(canonicalize(hashed)).digest("hex");
}

function hasAnyReconnectField(r: UpstreamReconnectInputs): boolean {
  return (
    r.maxReconnectAttempts !== undefined ||
    r.reconnectBaseDelay !== undefined ||
    r.reconnectMaxDelay !== undefined
  );
}

function canonicalize(value: unknown): string {
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
