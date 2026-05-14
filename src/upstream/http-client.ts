import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HttpServerConfig } from "../config/schema.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import { hasCredentialTemplates, resolveCredentialTemplates } from "../credentials/resolve-templates.js";
import { hasStoredOAuthCredential, resolveClientSecret } from "../oauth/client-secret.js";
import {
  BridgeOAuthClientProvider,
  makeOriginPinningFetch,
} from "../oauth/sdk-provider.js";
import { BaseUpstreamClient } from "./base-client.js";
import type { BaseUpstreamClientOptions } from "./base-client.js";

export interface HttpUpstreamClientOptions extends BaseUpstreamClientOptions {
  config: HttpServerConfig;
  credentialStore?: CredentialStore;
}

export class HttpUpstreamClient extends BaseUpstreamClient {
  private _config: HttpServerConfig;
  private _credentialStore: CredentialStore | undefined;
  private _resolvedHeaders: Record<string, string> | undefined;
  private _resolvedClientSecret: string | undefined;
  private _hasStoredOAuth = false;
  private _authShadowWarned = false;

  constructor(options: HttpUpstreamClientOptions) {
    super(options);
    this._config = options.config;
    this._credentialStore = options.credentialStore;
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
        process.env,
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
          })
        : undefined;

    // CRITICAL: strip (not just warn) any case-insensitive `Authorization`
    // header when an `authProvider` is in play. The SDK's
    // `_commonHeaders()` spreads transport `requestInit.headers` AFTER the
    // provider's bearer, so leaving the static header in place would
    // silently override the OAuth-managed token on every request — the
    // exact opposite of what a user configuring `_bridge.auth` expects.
    let effectiveHeaders = rawHeaders;
    if (authProvider && rawHeaders) {
      const filtered: Record<string, string> = {};
      let shadowed = false;
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (k.toLowerCase() === "authorization") {
          shadowed = true;
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
      effectiveHeaders = filtered;
    }

    const requestInit: RequestInit | undefined = effectiveHeaders
      ? { headers: effectiveHeaders as Record<string, string> }
      : undefined;

    // Pin token-endpoint origin to authorization-endpoint origin via the
    // transport's fetch override. This protects the runtime refresh leg
    // against tampered AS metadata pointing the token endpoint at an
    // attacker-controlled origin. Only installed when OAuth is configured.
    const fetch = authProvider ? makeOriginPinningFetch() : undefined;

    // Build options once so the conditional spread isn't duplicated across
    // the two transport types.
    const transportOpts = authProvider
      ? { requestInit, authProvider, ...(fetch ? { fetch } : {}) }
      : { requestInit };

    if (this._config.type !== "sse") {
      return new StreamableHTTPClientTransport(url, transportOpts);
    }
    return new SSEClientTransport(url, transportOpts);
  }
}
