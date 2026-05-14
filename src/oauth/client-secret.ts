import type { Logger } from "../logging/index.js";
import type { BridgeConfig } from "../config/schema.js";
import { resolveUpstreams } from "../config/schema.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import { resolveCredentialValue } from "../credentials/types.js";

const ENV_REF = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
/**
 * Allowlist for env-var names referenced from `clientSecret`. A tampered
 * config could otherwise interpolate any env var (e.g. `${AWS_SECRET_ACCESS_KEY}`)
 * and exfiltrate it as the POSTed `client_secret`. The token `OAUTH` (with
 * an optional leading `X` for SASL/IMAP-style `XOAUTH2_*` names) must
 * appear bounded by start-of-string-or-underscore on the left AND by
 * end-of-string, underscore, or `2_` on the right. That keeps conventional
 * names working (`OAUTH_SECRET`, `NOTION_OAUTH_SECRET`,
 * `GOOGLE_OAUTH2_CLIENT_SECRET`, `XOAUTH2_BEARER`) while rejecting names
 * that happen to share the prefix (`OAUTHORITY`, `OAUTHIBITED`). The
 * left-anchor `_` boundary alone (the previous behavior) accepted those.
 * Case-insensitive matching is also dropped — POSIX env vars are
 * conventionally uppercase, and accepting `oauth_foo` invited drift.
 */
const ALLOWED_ENV_NAME = /(^|_)X?OAUTH2?(_|$)/;

/**
 * Credential-store key for tokens minted by `mcp-bridge auth`. The server
 * name is percent-encoded so a name containing `:` (or any other byte) can't
 * collide with another server's `oauth:<name>` / `oauth-client-secret:<name>`
 * keyspace. ASCII-safe names round-trip unchanged.
 */
export function oauthCredentialKey(serverName: string): string {
  return `oauth:${encodeURIComponent(serverName)}`;
}

/** Credential-store key for confidential-client secrets. Percent-encoded for
 * the same collision-avoidance reason as `oauthCredentialKey`. */
export function clientSecretKey(serverName: string): string {
  return `oauth-client-secret:${encodeURIComponent(serverName)}`;
}

/** Credential-store key for dynamically-registered client info (RFC 7591).
 * Single source of truth so `auth --remove` and the SDK provider can't drift. */
export function clientInfoKey(serverName: string): string {
  return `oauth-client:${encodeURIComponent(serverName)}`;
}

/**
 * Resolve a client secret in this priority order:
 *  1. Encrypted credential store under `oauth-client-secret:<server>`.
 *  2. `${ENV_VAR}` reference in `configValue` resolved against `env`.
 *  3. Plain string in `configValue`.
 *
 * Returns `undefined` when no source produced a value — callers treat the
 * client as public (PKCE only).
 *
 * An env reference whose env var is unset throws so a stale config doesn't
 * silently fall back to "no secret" and confuse the provider.
 *
 * `logger` (optional) is used to warn when source 3 (inline plain string) is
 * taken — plain secrets in config are discouraged because config files are
 * often shared/committed.
 */
export async function resolveClientSecret(
  serverName: string,
  configValue: string | undefined,
  store: CredentialStore | undefined,
  env: Record<string, string | undefined> = process.env,
  logger?: Logger,
): Promise<string | undefined> {
  // 1. Credential store
  if (store) {
    const stored = await store.get(clientSecretKey(serverName));
    if (stored) return resolveCredentialValue(stored);
  }

  if (!configValue) return undefined;

  // 2. Env-var reference
  const match = configValue.match(ENV_REF);
  if (match) {
    const varName = match[1];
    if (!ALLOWED_ENV_NAME.test(varName)) {
      throw new Error(
        `Client secret env var "${varName}" is not allowed (referenced by "${serverName}._bridge.auth.clientSecret"). ` +
        `The variable name must contain "OAUTH" as a bounded segment ` +
        `(e.g. NOTION_OAUTH_SECRET, GOOGLE_OAUTH2_CLIENT_SECRET, XOAUTH2_BEARER).`,
      );
    }
    const value = env[varName];
    if (value === undefined || value === "") {
      throw new Error(
        `Client secret env var "${varName}" is not set (referenced by "${serverName}._bridge.auth.clientSecret")`,
      );
    }
    return value;
  }

  // 3. Plain string — discouraged; warn once per resolution so log noise is bounded.
  if (logger && configValue.length >= 8) {
    logger.warn(
      `clientSecret for "${serverName}" is an inline string in config. ` +
      `Prefer the credential store (\`credential set ${clientSecretKey(serverName)} <value>\`) ` +
      `or an \${ENV_VAR} reference so secrets stay out of shared config files.`,
      { component: "oauth" },
    );
  }
  return configValue;
}

/**
 * Returns true when the credential store holds an `oauth:<serverName>`
 * credential. Used by the runtime HTTP client to autodetect OAuth from
 * stored tokens, so the user doesn't have to duplicate the OAuth signal
 * that the upstream already advertises via RFC 9728 / WWW-Authenticate.
 */
export async function hasStoredOAuthCredential(
  store: CredentialStore,
  serverName: string,
): Promise<boolean> {
  const stored = await store.get(oauthCredentialKey(serverName));
  return stored?.type === "oauth2";
}

/**
 * Scan a loaded `BridgeConfig` for inline plain-string `clientSecret` values
 * and report them. Used to surface "your config file contains a literal
 * secret" before the user runs `auth` / starts the daemon — the lazy warning
 * in `resolveClientSecret` only fires once the upstream is touched, which is
 * often after the config has already been committed.
 *
 * Excludes `${ENV_VAR}` references (those are intended) and empty strings.
 */
export function findInlineClientSecrets(config: BridgeConfig): string[] {
  const upstreams = resolveUpstreams(config);
  const offenders: string[] = [];
  for (const [name, server] of Object.entries(upstreams)) {
    const secret = server._bridge?.auth?.clientSecret;
    if (typeof secret !== "string" || secret.length === 0) continue;
    if (ENV_REF.test(secret)) continue;
    offenders.push(name);
  }
  return offenders;
}
