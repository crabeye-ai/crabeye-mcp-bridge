import { timingSafeEqual } from "node:crypto";
import { auth, discoverOAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import { loadConfig, resolveConfigPath, ConfigError } from "../config/index.js";
import { loadMergedConfig } from "../config/merged-loader.js";
import {
  resolveUpstreams,
  isHttpServer,
  type BridgeConfig,
  type HttpServerConfig,
  type ServerConfig,
  type ServerOAuthConfig,
} from "../config/schema.js";
import {
  CredentialStore,
  CredentialError,
  createKeychainAdapter,
} from "../credentials/index.js";
import {
  clientInfoKey,
  clientSecretKey,
  findInlineClientSecrets,
  makeOriginPinningFetch,
  oauthCredentialKey,
  resolveClientSecret,
  openBrowser,
  startCallbackServer,
  type CallbackServerHandle,
  OAuthError,
} from "../oauth/index.js";
import { BridgeOAuthClientProvider } from "../oauth/sdk-provider.js";
import { APP_NAME } from "../constants.js";

const USAGE = `Usage:
  ${APP_NAME} auth <server>            run OAuth flow for a server
  ${APP_NAME} auth --list              show auth status for all servers (default)
  ${APP_NAME} auth --remove <server>   delete stored credentials for a server
  ${APP_NAME} auth help                show this help

Options:
  --list                show auth status for all servers (default for bare invocation)
  --remove <server>     delete the stored \`oauth:<server>\` credential (local only)
  -h, --help            show this help
`;

export { USAGE as authUsage };

/** Bound on the RFC 9728 discovery probe used by `--list`. Configured servers
 * are still drawn from config without this round-trip; only the speculative
 * "does this non-configured HTTP server advertise OAuth?" probe is timed. */
const DISCOVERY_PROBE_TIMEOUT_MS = 3_000;

export interface AuthCommandDeps {
  print?: (line: string) => void;
  errPrint?: (line: string) => void;
  store?: CredentialStore;
  loadConfig?: () => Promise<BridgeConfig>;
  /** Inject the SDK's `auth()` helper for testing. */
  auth?: typeof auth;
  /** Inject for testing the loopback callback server. */
  startCallbackServer?: typeof startCallbackServer;
  /** Inject for testing the browser launcher. */
  openBrowser?: typeof openBrowser;
  /** Inject for testing RFC 9728 probes in `--list`. */
  discoverProtectedResource?: typeof discoverOAuthProtectedResourceMetadata;
}

function defaultPrint(line: string): void {
  process.stdout.write(line + "\n");
}
function defaultErrPrint(line: string): void {
  process.stderr.write(line + "\n");
}

async function loadConfigForAuth(explicitPath?: string): Promise<BridgeConfig> {
  if (explicitPath) {
    const configPath = resolveConfigPath({ configPath: explicitPath });
    return loadConfig({ configPath });
  }
  const envPath = process.env.MCP_BRIDGE_CONFIG;
  if (envPath) return loadConfig({ configPath: envPath });
  const merged = await loadMergedConfig();
  return merged.config;
}

function formatExpiry(expiresAt: number | undefined): string {
  if (expiresAt === undefined) return "—";
  // Local time matches the bridge's text logger convention; UTC ISO strings
  // here surprised users running `auth --list` to check "is my token
  // expired?" with output that didn't match their wall clock.
  return new Date(expiresAt * 1000).toLocaleString();
}

function isExpired(expiresAt: number | undefined): boolean {
  if (expiresAt === undefined) return false;
  return expiresAt * 1000 <= Date.now();
}

interface AuthRow {
  name: string;
  status: "authenticated" | "auth-required" | "advertises-oauth";
  expiresAt: number | undefined;
  scopes: string[];
  source: "config" | "discovery";
}

async function buildStatusRows(
  config: BridgeConfig,
  store: CredentialStore,
  discover: typeof discoverOAuthProtectedResourceMetadata,
): Promise<AuthRow[]> {
  const upstreams = resolveUpstreams(config);

  // Build one promise per server. Each promise returns either an AuthRow or
  // undefined (server has no config + no discovery advertisement + no stored
  // credentials). Running in parallel keeps `--list` responsive against slow
  // upstreams; the discovery probe is also bounded by
  // DISCOVERY_PROBE_TIMEOUT_MS so a dead server can't pin the whole command.
  const rowPromises = Object.entries(upstreams).map(
    async ([name, server]): Promise<AuthRow | undefined> => {
      const oauthCfg = server._bridge?.auth;
      if (oauthCfg && oauthCfg.type === "oauth2") {
        return rowFromConfig(name, oauthCfg.scopes ?? [], store);
      }
      if (!isHttpServer(server)) return undefined;

      // Discovery-driven path: server has no explicit `_bridge.auth` but
      // may advertise OAuth via RFC 9728, and `auth <server>` may have
      // already written tokens to the store on a previous run. Check both
      // — stored creds win because once a user has authenticated, they
      // care about expiry/scope, not the bare "this server advertises
      // OAuth" status.
      const [advertises, stored] = await Promise.all([
        probeOAuthAdvertised(server, discover),
        store.get(oauthCredentialKey(name)),
      ]);
      if (stored && stored.type === "oauth2") {
        return rowFromStoredCredential(name, stored, "discovery");
      }
      if (!advertises) return undefined;
      return {
        name,
        status: "advertises-oauth",
        expiresAt: undefined,
        scopes: [],
        source: "discovery",
      };
    },
  );

  const rows = (await Promise.all(rowPromises)).filter(
    (r): r is AuthRow => r !== undefined,
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function probeOAuthAdvertised(
  server: HttpServerConfig,
  discover: typeof discoverOAuthProtectedResourceMetadata,
): Promise<boolean> {
  // Discovery is network-bound. A slow or hung HTTP upstream would otherwise
  // make `--list` look broken. AbortSignal.timeout requires Node 17.3+.
  const signal = AbortSignal.timeout(DISCOVERY_PROBE_TIMEOUT_MS);
  try {
    const meta = await discover(server.url, { signal });
    return meta !== undefined;
  } catch {
    // Discovery probe failed (network, timeout, malformed metadata, etc.) —
    // don't surface speculative auth-required rows for servers that may
    // simply not support OAuth.
    return false;
  }
}

async function rowFromConfig(
  name: string,
  scopes: string[],
  store: CredentialStore,
): Promise<AuthRow> {
  const cred = await store.get(oauthCredentialKey(name));
  if (!cred || cred.type !== "oauth2") {
    return {
      name,
      status: "auth-required",
      expiresAt: undefined,
      scopes,
      source: "config",
    };
  }
  return rowFromStoredCredential(name, cred, "config", scopes);
}

/** Build a status row from an already-fetched stored credential. Used by
 * both the config-driven and discovery-driven paths so the "expired with no
 * refresh → auth-required" logic stays in one place. */
function rowFromStoredCredential(
  name: string,
  cred: import("../credentials/types.js").OAuth2Credential,
  source: AuthRow["source"],
  configuredScopes: string[] = [],
): AuthRow {
  const hasRefresh = typeof cred.refresh_token === "string" && cred.refresh_token.length > 0;
  const status: AuthRow["status"] =
    isExpired(cred.expires_at) && !hasRefresh ? "auth-required" : "authenticated";
  return {
    name,
    status,
    expiresAt: cred.expires_at,
    scopes: configuredScopes,
    source,
  };
}

function renderRows(rows: AuthRow[]): string {
  if (rows.length === 0) {
    return "No servers with OAuth configuration or advertised OAuth metadata.";
  }
  const headers = ["SERVER", "STATUS", "EXPIRES", "SCOPES", "SOURCE"];
  const data = rows.map((r) => [
    r.name,
    r.status,
    formatExpiry(r.expiresAt),
    r.scopes.length > 0 ? r.scopes.join(" ") : "—",
    r.source,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map((row) => row[i].length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [fmt(headers), ...data.map(fmt)].join("\n");
}

export async function runAuthList(
  opts: { configPath?: string },
  deps: AuthCommandDeps = {},
): Promise<number> {
  const print = deps.print ?? defaultPrint;
  const errPrint = deps.errPrint ?? defaultErrPrint;
  try {
    const config = deps.loadConfig
      ? await deps.loadConfig()
      : await loadConfigForAuth(opts.configPath);
    warnInlineClientSecrets(config, errPrint);
    const store = deps.store ?? new CredentialStore({ keychain: createKeychainAdapter() });
    const discover = deps.discoverProtectedResource ?? discoverOAuthProtectedResourceMetadata;
    const rows = await buildStatusRows(config, store, discover);
    print(renderRows(rows));
    return 0;
  } catch (err) {
    errPrint(`Error: ${formatErr(err)}`);
    return 1;
  }
}

/**
 * Surface inline plain-string `clientSecret` values at command-entry time
 * rather than lazily inside `resolveClientSecret`. The repo is open source
 * and config files are routinely committed — the friction point is the
 * commit, not the first connect.
 */
function warnInlineClientSecrets(
  config: BridgeConfig,
  errPrint: (line: string) => void,
): void {
  const offenders = findInlineClientSecrets(config);
  for (const name of offenders) {
    errPrint(
      `warning: clientSecret for "${name}" is an inline string in config. ` +
      `Prefer the credential store (\`credential set ${clientSecretKey(name)} <value>\`) ` +
      `or a \${ENV_VAR} reference so secrets stay out of shared config files.`,
    );
  }
}

export async function runAuthRemove(
  serverName: string,
  opts: { configPath?: string } = {},
  deps: AuthCommandDeps = {},
): Promise<number> {
  const print = deps.print ?? defaultPrint;
  const errPrint = deps.errPrint ?? defaultErrPrint;
  try {
    const store = deps.store ?? new CredentialStore({ keychain: createKeychainAdapter() });

    // Try to canonicalize the user-typed name against the current config so
    // `--remove Notion` finds keys stored as `oauth:notion`. Config load is
    // best-effort here: stale credentials for a server that was removed
    // from config should still be deletable by exact name (verbatim
    // fallback). Config load failures are silently treated as "no
    // canonicalization available" rather than aborting the removal.
    let canonical = serverName;
    try {
      const config = deps.loadConfig
        ? await deps.loadConfig()
        : await loadConfigForAuth(opts.configPath);
      const resolved = findUpstreamName(resolveUpstreams(config), serverName);
      if (resolved) canonical = resolved;
    } catch {
      // Continue with verbatim input.
    }

    const tokenKey = oauthCredentialKey(canonical);
    const secretKey = clientSecretKey(canonical);
    // Also clear dynamically-registered client info so a re-run of `auth`
    // starts cleanly. `--remove` is local-only — the OAuth server may still
    // hold a client registration for us until it's revoked there.
    const clientKey = clientInfoKey(canonical);
    const removed = await store.deleteMany([tokenKey, secretKey, clientKey]);
    if (removed.length === 0) {
      errPrint(`No stored credentials for "${serverName}"`);
      return 1;
    }
    const parts: string[] = [];
    if (removed.includes(tokenKey)) parts.push("token");
    if (removed.includes(secretKey)) parts.push("client secret");
    if (removed.includes(clientKey)) parts.push("registered client");
    print(`Removed local ${parts.join(" + ")} for "${canonical}"`);
    return 0;
  } catch (err) {
    errPrint(`Error: ${formatErr(err)}`);
    return 1;
  }
}

/**
 * Look up a server by the name the user typed on the CLI, case-insensitively.
 * Returns the canonical config name so downstream callers can use it
 * consistently for credential-store keys and log messages — otherwise
 * `auth Notion` and `auth notion` would write to different `oauth:<name>`
 * entries. Exact-case matches win to keep behaviour deterministic when the
 * user has multiple servers whose names differ only in case.
 */
function findUpstreamName(
  upstreams: Record<string, ServerConfig>,
  typed: string,
): string | undefined {
  if (Object.hasOwn(upstreams, typed)) return typed;
  const lower = typed.toLowerCase();
  for (const name of Object.keys(upstreams)) {
    if (name.toLowerCase() === lower) return name;
  }
  return undefined;
}

function getUpstream(
  config: BridgeConfig,
  name: string,
): {
  canonicalName: string;
  server: HttpServerConfig;
  authConfig: ServerOAuthConfig | undefined;
} | undefined {
  const upstreams = resolveUpstreams(config);
  const canonicalName = findUpstreamName(upstreams, name);
  if (canonicalName === undefined) return undefined;
  const server: ServerConfig = upstreams[canonicalName];
  if (!isHttpServer(server)) return undefined;
  return { canonicalName, server, authConfig: server._bridge?.auth };
}

/** Reject authorization URLs that the SDK derived from discovery against a
 * non-HTTPS origin — handing a plain-HTTP authorization URL to the browser
 * would let a network-positioned attacker (or a compromised RFC 9728
 * resource metadata response over http) phish the user into authorizing on
 * an attacker-controlled origin with their cookies/SSO active. Allow any
 * loopback authorization URL (local-IdP dev/test setups against remote
 * upstreams) — the user already trusts inbound on their own loopback
 * interface. URLs with embedded userinfo are also rejected; browsers
 * sometimes auto-fill credentials from `https://user:pass@host` and this is
 * never legitimate for OAuth. */
function assertSafeAuthorizationUrl(authUrl: URL): void {
  if (authUrl.username !== "" || authUrl.password !== "") {
    throw new OAuthError(
      "insecure_authorization_url",
      `Authorization URL must not embed userinfo (got ${authUrl.protocol}//${authUrl.host}).`,
    );
  }
  if (authUrl.protocol === "https:") return;
  const loopback = new Set(["localhost", "127.0.0.1", "::1"]);
  if (loopback.has(authUrl.hostname)) return;
  throw new OAuthError(
    "insecure_authorization_url",
    `Authorization endpoint must use https (got ${authUrl.protocol}//${authUrl.host}). ` +
      `Refusing to open the browser at an insecure URL.`,
  );
}

export async function runAuthLogin(
  opts: { configPath?: string; serverName: string },
  deps: AuthCommandDeps & { signal?: AbortSignal } = {},
): Promise<number> {
  const print = deps.print ?? defaultPrint;
  const errPrint = deps.errPrint ?? defaultErrPrint;

  let handle: CallbackServerHandle | undefined;

  try {
    const config = deps.loadConfig
      ? await deps.loadConfig()
      : await loadConfigForAuth(opts.configPath);
    warnInlineClientSecrets(config, errPrint);

    const upstream = getUpstream(config, opts.serverName);
    if (!upstream) {
      errPrint(
        `Error: server "${opts.serverName}" is not configured or is not an HTTP upstream.\n` +
        `  OAuth via \`auth <server>\` requires an HTTP/streamable-http server.`,
      );
      return 1;
    }

    const store = deps.store ?? new CredentialStore({ keychain: createKeychainAdapter() });
    const authConfig = upstream.authConfig;
    // Use the canonical config name for credential-store keys and log
    // messages so `auth Notion` and `auth notion` operate on the same
    // `oauth:<name>` entry rather than diverging by case.
    const serverName = upstream.canonicalName;

    // Resolve the client secret BEFORE starting the loopback listener — if
    // resolution throws (missing env var, etc.) we don't want to leak a
    // bound port that the user has to manually free.
    const clientSecret = await resolveClientSecret(
      serverName,
      authConfig?.clientSecret,
      store,
    );

    const startFn = deps.startCallbackServer ?? startCallbackServer;
    const openFn = deps.openBrowser ?? openBrowser;
    const authFn = deps.auth ?? auth;

    handle = await startFn({
      port: authConfig?.redirectPort,
      signal: deps.signal,
    });

    const provider = new BridgeOAuthClientProvider({
      serverName,
      store,
      redirectUrl: handle.redirectUri,
      clientId: authConfig?.clientId,
      clientSecret,
      scopes: authConfig?.scopes,
      onRedirect: async (url) => {
        assertSafeAuthorizationUrl(url);
        errPrint(`Opening authorization URL for "${serverName}":`);
        errPrint(`  ${url}`);
        errPrint(`Listening on ${handle!.redirectUri} (Ctrl-C to cancel)`);
        // Surface launcher rejections (unhandled-rejection avoidance) — the
        // user may still complete auth by pasting the URL manually.
        void openFn(String(url)).catch(() => undefined);
      },
    });

    // Pin token-endpoint origin to the authorization-endpoint origin via
    // the SDK's fetchFn hook. A tampered AS metadata response would
    // otherwise let the SDK POST the authorization code + PKCE verifier +
    // client_secret to an attacker-controlled origin.
    const pinningFetch = makeOriginPinningFetch();

    const first = await authFn(provider, {
      serverUrl: upstream.server.url,
      fetchFn: pinningFetch,
    });
    if (first === "AUTHORIZED") {
      // Already authorized via cached tokens — nothing more to do.
      print(`Already authenticated as "${serverName}"`);
      return 0;
    }

    // first === "REDIRECT": SDK invoked onRedirect; wait for the callback.
    const callback = await handle.result;

    // Verify the CSRF `state` echoed back matches the value we issued. The
    // SDK requests state via `provider.state()` and includes it on the
    // authorization URL; a mismatch indicates either a stale flow from a
    // different attempt or — more dangerously — a same-machine attacker who
    // posted a forged callback to the loopback listener with their own code.
    const expected = provider.expectedState();
    if (expected === undefined) {
      errPrint(
        `Error: OAuth flow did not initialize state — internal error.\n` +
        `  Re-run \`${APP_NAME} auth ${serverName}\`.`,
      );
      return 1;
    }
    if (!constantTimeEquals(expected, callback.state)) {
      errPrint(
        `Error: OAuth state mismatch — refusing to exchange the callback code.\n` +
        `  This usually means the authorization flow was interrupted or a stale\n` +
        `  callback arrived. Re-run \`${APP_NAME} auth ${serverName}\`.`,
      );
      return 1;
    }

    const result = await authFn(provider, {
      serverUrl: upstream.server.url,
      authorizationCode: callback.code,
      fetchFn: pinningFetch,
    });

    if (result !== "AUTHORIZED") {
      errPrint("Error: authorization did not complete");
      return 1;
    }

    const stored = await provider.tokens();
    print(`Authenticated "${serverName}"`);
    if (stored?.scope) print(`  Scopes: ${stored.scope}`);
    if (stored?.expires_in !== undefined) {
      const expiresAt = Math.floor(Date.now() / 1000) + stored.expires_in;
      print(`  Expires: ${formatExpiry(expiresAt)}`);
    }
    return 0;
  } catch (err) {
    errPrint(`Error: ${formatErr(err)}`);
    return 1;
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (closeErr) {
        // A leaked listener on a pinned `redirectPort` would otherwise
        // surface as EADDRINUSE on the next `auth` invocation with no hint
        // about what to do about it. Surface the close failure to stderr
        // via the injected printer so tests can observe it.
        const message = closeErr instanceof Error ? closeErr.message : String(closeErr);
        errPrint(`warning: failed to close callback listener: ${message}`);
      }
    }
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function formatErr(err: unknown): string {
  if (err instanceof ConfigError) {
    let msg = err.message;
    for (const issue of err.issues) msg += `\n  ${issue.path}: ${issue.message}`;
    return msg;
  }
  if (err instanceof CredentialError || err instanceof OAuthError) return err.message;
  // SDK throws `OAuthError` subclasses (server-auth/errors) with an
  // `errorCode` field carrying machine-readable codes (`invalid_grant`,
  // `invalid_client`, …). Surface the code so users can diagnose without
  // having to dig through SDK source.
  if (
    err instanceof Error &&
    typeof (err as { errorCode?: unknown }).errorCode === "string"
  ) {
    return `[${(err as { errorCode: string }).errorCode}] ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
