import { UPSTREAM_MARKER_ENV } from "../../constants.js";
import { MASTER_KEY_ENV } from "../../credentials/keychain.js";
import { envNameFor } from "../instance-env.js";

/** At most how large, in UTF-8 bytes of names and values, a bridge's environment may be when it attaches. */
export const MAX_CHILD_ENV_BYTES = 4 * 1024 * 1024;

/**
 * Variables that make a STDIO server's runtime or dynamic loader run other
 * code. Never passed to a child, whether a client's environment or the
 * server's `env` sets them.
 */
const SPAWN_DENYLIST: readonly string[] = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_DEBUG",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PRESERVE_SYMLINKS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
  MASTER_KEY_ENV,
];

/**
 * A STDIO server's environment: the client's, then the server's `env` over it,
 * without the denylisted variables, and marked as started by this manager.
 * Names differing only in case are one variable on Windows; the server's
 * spelling wins.
 */
export function spawnEnv(
  childEnv: Record<string, string>,
  serverEnv: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const denied = new Set(SPAWN_DENYLIST.map((name) => envNameFor(name, platform)));
  const merged = new Map<string, [string, string]>();
  for (const source of [childEnv, serverEnv]) {
    for (const [name, value] of Object.entries(source)) {
      const key = envNameFor(name, platform);
      if (!denied.has(key)) merged.set(key, [name, value]);
    }
  }
  merged.delete(envNameFor(UPSTREAM_MARKER_ENV, platform));
  const out = Object.fromEntries(merged.values());
  out[UPSTREAM_MARKER_ENV] = String(process.pid);
  return out;
}
