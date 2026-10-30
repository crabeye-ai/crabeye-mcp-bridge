import { StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { Transport } from "@modelcontextprotocol/client";
import type { HttpServerConfig } from "../config/schema.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import { hasCredentialTemplates, isSendableHeaderValue, resolveCredentialTemplates } from "../credentials/resolve-templates.js";
import { hasStoredOAuthCredential, resolveClientSecret } from "../oauth/client-secret.js";
import {
  BridgeOAuthClientProvider,
} from "../oauth/sdk-provider.js";
import type { PendingSaves } from "../oauth/pending-saves.js";
import type { SharedRefreshes } from "../oauth/shared-refreshes.js";
import { isDefinitiveAuthFailure, isReauthorizationRequired } from "../oauth/errors.js";
import { makeOriginPinningFetch } from "../oauth/origin-pinning.js";
import { BaseUpstreamClient } from "./base-client.js";
import type { BaseUpstreamClientOptions } from "./base-client.js";

const TRANSPORT_OWNED_HEADERS = new Set(["mcp-method", "mcp-name", "mcp-protocol-version", "mcp-session-id"]);

function isTransportOwnedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return TRANSPORT_OWNED_HEADERS.has(lower) || lower.startsWith("mcp-param-");
}

export interface HttpUpstreamClientOptions extends BaseUpstreamClientOptions {
  config: HttpServerConfig;
  credentialStore?: CredentialStore;
  /** Makes every request of the connection, OAuth included. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Where a `clientSecret` of the form `${NAME}` is looked up. Defaults to no variables at all. */
  env?: Record<string, string | undefined>;
  /** Shared with the other connections whose refreshes should coalesce with this one's. */
  refreshes?: SharedRefreshes;
  /** Counts this connection's refreshes until their tokens are saved. */
  pendingSaves?: PendingSaves;
}

export class HttpUpstreamClient extends BaseUpstreamClient {
  private _config: HttpServerConfig;
  private _warnedSseDeprecated = false;
  private _credentialStore: CredentialStore | undefined;
  private _resolvedHeaders: Record<string, string> | undefined;
  private _resolvedClientSecret: string | undefined;
  private _hasStoredOAuth = false;
  private _authShadowWarned = false;
  private _transportOwnedWarned = false;
  private _authProvider: BridgeOAuthClientProvider | undefined;
  private _authRetirement = new AbortController();
  private _fetch: typeof fetch | undefined;
  private readonly _env: Record<string, string | undefined>;
  private readonly _refreshes: SharedRefreshes | undefined;
  private readonly _pendingSaves: PendingSaves | undefined;

  constructor(options: HttpUpstreamClientOptions) {
    super(options);
    this._config = options.config;
    this._credentialStore = options.credentialStore;
    this._fetch = options.fetch;
    this._env = options.env ?? {};
    this._refreshes = options.refreshes;
    this._pendingSaves = options.pendingSaves;
  }

  protected override async _prepareConnect(): Promise<void> {
    this._resolvedHeaders = undefined;
    if (
      this._credentialStore &&
      this._config.headers &&
      hasCredentialTemplates(this._config.headers as Record<string, string>)
    ) {
      this._resolvedHeaders = await resolveCredentialTemplates(
        this._config.headers as Record<string, string>,
        this._credentialStore,
      );
    }

    // Resolve `${ENV}`/credential-store references on `clientSecret` here so
    // a literal `"${OAUTH_X}"` from config doesn't end up POSTed as the
    // client_secret on token refresh. Resolution errors (missing env var,
    // missing store entry) are intentionally surfaced as connect failures
    // rather than swallowed — confidential clients silently misconfigured
    // are harder to diagnose than a clear startup error.
    this._resolvedClientSecret = undefined;
    const authConfig = this._config._bridge?.auth;
    if (authConfig && this._credentialStore) {
      this._resolvedClientSecret = await resolveClientSecret(
        this.name,
        authConfig.clientSecret,
        this._credentialStore,
        this._env,
        this._logger,
      );
    }

    // Autodetect: if the user has previously run `mcp-bridge auth <server>`
    // (tokens stored under `oauth:<server>`), use OAuth at runtime even when
    // the upstream config doesn't carry an explicit `_bridge.auth` block.
    // OAuth-protected MCP servers advertise this via RFC 9728 / WWW-
    // Authenticate; making the user duplicate that into the client-side
    // config would be redundant. Stored tokens are the durable signal that
    // the user opted in.
    this._hasStoredOAuth = false;
    if (this._credentialStore && !authConfig) {
      this._hasStoredOAuth = await hasStoredOAuthCredential(
        this._credentialStore,
        this.name,
      );
    }
  }

  /**
   * Keeps every OAuth provider this client has built from starting refreshes
   * or changing stored credentials, since they changed elsewhere; the
   * connection must then be replaced, which builds a new provider.
   */
  retireAuth(): void {
    this._authRetirement.abort();
    this._authRetirement = new AbortController();
  }

  protected override _isAuthFailure(err: unknown): boolean {
    if (isDefinitiveAuthFailure(err)) return true;
    if (this._authProvider?.refreshFailedTransiently) return false;
    return isReauthorizationRequired(err);
  }

  protected _buildTransport(): Transport {
    const url = new URL(this._config.url);
    const rawHeaders = this._resolvedHeaders ?? this._config.headers;

    // Hand the transport an `OAuthClientProvider` when either:
    //  - The upstream config has `_bridge.auth` (explicit opt-in), or
    //  - The credential store already holds `oauth:<server>` tokens from a
    //    previous `mcp-bridge auth <server>` run (autodetect).
    //
    // The SDK handles RFC 9728 discovery, refresh-on-401, and (when no prior
    // auth) raising `UnauthorizedError` so the bridge can prompt the user to
    // run `mcp-bridge auth <server>`.
    const authConfig = this._config._bridge?.auth;
    const useOAuth = this._credentialStore && (authConfig || this._hasStoredOAuth);
    const authProvider =
      useOAuth && this._credentialStore
        ? new BridgeOAuthClientProvider({
            serverName: this.name,
            store: this._credentialStore,
            // Runtime providers never actually serve a callback; the SDK only
            // needs the URL string to build authorization URLs. The
            // `runtime: true` flag below also disables dynamic registration
            // here because the daemon has no port-bound listener.
            redirectUrl: "http://127.0.0.1/callback",
            clientId: authConfig?.clientId,
            clientSecret: this._resolvedClientSecret,
            scopes: authConfig?.scopes,
            logger: this._logger,
            runtime: true,
            refreshes: this._refreshes,
            pendingSaves: this._pendingSaves,
            retirement: this._authRetirement.signal,
          })
        : undefined;
    this._authProvider = authProvider;

    const effectiveHeaders = rawHeaders && this._configuredRequestHeaders(rawHeaders, authProvider !== undefined);
    rejectUnsendableHeaders(effectiveHeaders);

    const requestInit: RequestInit | undefined = effectiveHeaders
      ? { headers: effectiveHeaders }
      : undefined;

    // Pin token-endpoint origin to authorization-endpoint origin via the
    // transport's fetch override. This protects the runtime refresh leg
    // against tampered AS metadata pointing the token endpoint at an
    // attacker-controlled origin. Layered with the provider's token-endpoint
    // wrapper so concurrent 401s coalesce to a single token-endpoint POST
    // (avoids the IdP rotating away under N parallel refresh attempts) and
    // the provider learns which refresh tokens were rejected.
    // Without OAuth, the transport uses the connection's own fetch, when one was given.
    const fetch = authProvider
      ? authProvider.wrapFetch(makeOriginPinningFetch(this._fetch))
      : this._fetch;

    // Build options once so the conditional spread isn't duplicated across
    // the two transport types.
    const transportOpts = {
      requestInit,
      ...(authProvider && { authProvider }),
      ...(fetch && { fetch }),
    };

    if (this._config.type !== "sse") {
      return new StreamableHTTPClientTransport(url, transportOpts);
    }
    if (!this._warnedSseDeprecated) {
      this._warnedSseDeprecated = true;
      this._logger.warn(
        'transport type "sse" is deprecated and will be removed on 2027-07-28 — switch to "streamable-http" if the server supports it',
      );
    }
    return new SSEClientTransport(url, transportOpts);
  }

  private _configuredRequestHeaders(
    rawHeaders: Record<string, string>,
    oauthManagesAuthorization: boolean,
  ): Record<string, string> {
    const filtered: Record<string, string> = {};
    const transportOwned: string[] = [];
    let shadowed = false;
    for (const [k, v] of Object.entries(rawHeaders)) {
      // CRITICAL: strip (not just warn) any case-insensitive `Authorization`
      // header when `oauthManagesAuthorization`. The SDK's
      // `_commonHeaders()` spreads transport `requestInit.headers` AFTER the
      // provider's bearer, so leaving the static header in place would
      // silently override the OAuth-managed token on every request — the
      // exact opposite of what a user configuring `_bridge.auth` expects.
      if (oauthManagesAuthorization && k.toLowerCase() === "authorization") {
        shadowed = true;
        continue;
      }
      if (isTransportOwnedHeader(k)) {
        transportOwned.push(k);
        continue;
      }
      filtered[k] = v;
    }
    if (shadowed && !this._authShadowWarned) {
      this._authShadowWarned = true;
      this._logger.warn(
        `stripped static Authorization header for "${this.name}" — _bridge.auth manages tokens for this server`,
      );
    }
    if (transportOwned.length > 0 && !this._transportOwnedWarned) {
      this._transportOwnedWarned = true;
      this._logger.warn(
        `ignored configured headers ${transportOwned.join(", ")} for "${this.name}" — the MCP transport sets them itself`,
      );
    }
    return filtered;
  }
}

/**
 * Throws for a header value fetch would refuse once it trims the value; the
 * error names the header only, since the value may be a secret.
 */
function rejectUnsendableHeaders(headers: Record<string, string> | undefined): void {
  for (const [header, value] of Object.entries(headers ?? {})) {
    if (!isSendableHeaderValue(value)) {
      throw new Error(`the value of header "${header}" contains a line break, a NUL or a character a header can't carry`);
    }
  }
}
