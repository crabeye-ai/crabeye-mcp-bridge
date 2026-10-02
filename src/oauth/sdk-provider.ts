import { randomBytes } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthClientInformationContext,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { APP_NAME, APP_VERSION } from "../constants.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import type { Logger } from "../logging/index.js";
import { clientInfoKey, clientIssuerKey, oauthCredentialKey } from "./client-secret.js";
import { OAuthError, ReauthorizationRequiredError } from "./errors.js";
import {
  isIssuerStampOnly,
  issuersMatch,
  parseStoredClientInfo,
} from "./issuer-binding.js";

export interface BridgeOAuthProviderOptions {
  serverName: string;
  store: CredentialStore;
  /**
   * Loopback redirect URL. Required even for runtime refreshes (some SDK
   * code paths read it during error recovery); for runtime-only providers
   * the value never actually receives a callback.
   */
  redirectUrl: string | URL;
  /** Configured client_id. When omitted, dynamic client registration kicks in. */
  clientId?: string;
  /** Optional confidential-client secret. */
  clientSecret?: string;
  /** Configured scopes. */
  scopes?: string[];
  /**
   * Called when the SDK wants the user agent redirected to the authorization
   * URL. The CLI flow opens the browser here; the runtime provider should
   * throw because no user is present to authorize.
   */
  onRedirect?: (url: URL) => void | Promise<void>;
  /** Logger used for refresh/discovery diagnostics. */
  logger?: Logger;
  /**
   * Runtime mode: no interactive user present. When true:
   *  - `saveClientInformation` refuses to persist dynamic registrations (the
   *    redirect_uri the daemon would advertise is portless and would not
   *    match the CLI flow's port-bound listener).
   *  - The refresh-loop circuit breaker is active.
   *
   * CLI flows set this `false` (default).
   */
  runtime?: boolean;
}

// Refresh-loop circuit breaker thresholds. If a runtime provider saves
// tokens more than this many times within the window, we mark it exhausted
// so the next `tokens()` call returns undefined — forcing the SDK to surface
// the `mcp-bridge auth <server>` message instead of hammering the token
// endpoint indefinitely against a refresh that succeeds but doesn't satisfy
// the upstream.
const REFRESH_WINDOW_MS = 60_000;
const REFRESH_BURST_LIMIT = 6;

type FetchLike = typeof fetch;

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * True when `init` describes an OAuth 2.0 refresh-token request: a POST whose
 * URL-encoded body carries `grant_type=refresh_token`. Used by
 * `BridgeOAuthClientProvider.wrapFetch` to coalesce parallel refresh attempts.
 *
 * The SDK's `refreshAuthorization` constructs the body with `URLSearchParams`;
 * `addClientAuthentication` hooks may serialize the body to a string before it
 * reaches `fetch`, so we accept both shapes.
 */
function isRefreshTokenRequest(init: RequestInit | undefined): boolean {
  if (!init) return false;
  const method = init.method?.toUpperCase();
  if (method !== "POST") return false;
  const body = init.body;
  if (body instanceof URLSearchParams) {
    return body.get("grant_type") === "refresh_token";
  }
  if (typeof body === "string") {
    return /(^|&)grant_type=refresh_token(&|$)/.test(body);
  }
  return false;
}

/**
 * `OAuthClientProvider` implementation backed by the bridge's encrypted
 * credential store.
 *
 * - Tokens live under `oauth:<server>` in our `OAuth2Credential` shape, with
 *   the SDK's `OAuthTokens` shape translated on read/write.
 * - Dynamically registered client information lives under `oauth-client:<server>`
 *   as a `secret` credential carrying the JSON blob (the store schema doesn't
 *   know about RFC 7591 — we serialise to keep the credential layer stable).
 * - PKCE verifier and CSRF `state` are held in memory for the lifetime of one
 *   provider instance. That covers the CLI single-process flow; runtime
 *   providers never see `saveCodeVerifier`/`state()` because refresh skips
 *   the authorization leg.
 */
export class BridgeOAuthClientProvider implements OAuthClientProvider {
  private readonly _opts: BridgeOAuthProviderOptions;
  private _verifier: string | undefined;
  private _state: string | undefined;
  private _recentSaves: number[] = [];
  private _refreshExhausted = false;
  private _refreshFailedTransiently = false;
  // In-flight token-endpoint refresh, used by `wrapFetch` to coalesce
  // parallel refresh attempts. See `wrapFetch` for the lifecycle.
  private _refreshFetchPromise: Promise<Response> | undefined;
  // Sync mirror of the stored credential's refresh_token. Lets `saveTokens`
  // preserve it on non-rotating IdPs without an async re-read, closing the
  // saveTokens-vs-invalidateCredentials TOCTOU.
  private _lastRefreshToken: string | undefined;
  // Monotonic counter bumped by `invalidateCredentials` for token-clearing
  // scopes. `tokens()` snapshots it before its `await store.get(...)` and
  // refuses to write the cache from a stale read whose result predates a
  // concurrent invalidate.
  private _invalidateEpoch = 0;
  private _discoveryState: OAuthDiscoveryState | undefined;

  get refreshFailedTransiently(): boolean {
    return this._refreshFailedTransiently && !this._refreshExhausted;
  }

  constructor(opts: BridgeOAuthProviderOptions) {
    this._opts = opts;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this._discoveryState;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this._discoveryState = state;
  }

  get redirectUrl(): string | URL {
    return this._opts.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const meta: OAuthClientMetadata = {
      redirect_uris: [String(this._opts.redirectUrl)],
      client_name: APP_NAME,
      client_uri: "https://github.com/crabeye-ai/crabeye-mcp-bridge",
      software_id: APP_NAME,
      software_version: APP_VERSION,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this._opts.clientSecret
        ? "client_secret_post"
        : "none",
    };
    if (this._opts.scopes && this._opts.scopes.length > 0) {
      meta.scope = this._opts.scopes.join(" ");
    }
    return meta;
  }

  async clientInformation(
    ctx?: OAuthClientInformationContext,
  ): Promise<StoredOAuthClientInformation | undefined> {
    if (this._opts.clientId) {
      const binding = parseStoredClientInfo(
        await this._opts.store.get(clientIssuerKey(this._opts.serverName)),
      );
      const recorded =
        binding?.client_id === this._opts.clientId ? binding.issuer : undefined;
      if (ctx?.issuer && recorded && !issuersMatch(recorded, ctx.issuer)) {
        throw new OAuthError(
          "issuer_mismatch",
          `Authorization server for "${this._opts.serverName}" is no longer ${recorded}. ` +
          `Refusing to send the configured client credentials to a different authorization server — ` +
          `if you did not expect this change, treat it as a possible mix-up attack and verify the server. ` +
          `If the change is legitimate, run \`${APP_NAME} auth --remove ${this._opts.serverName}\` first.`,
        );
      }
      if (ctx?.issuer && !recorded) {
        await this._opts.store.set(clientIssuerKey(this._opts.serverName), {
          type: "secret",
          value: JSON.stringify({ client_id: this._opts.clientId, issuer: ctx.issuer }),
        });
      }
      const issuer = recorded ?? ctx?.issuer;
      return {
        client_id: this._opts.clientId,
        ...(this._opts.clientSecret ? { client_secret: this._opts.clientSecret } : {}),
        ...(issuer ? { issuer } : {}),
      };
    }
    const stored = await this._opts.store.get(clientInfoKey(this._opts.serverName));
    if (!stored || stored.type !== "secret") {
      if (this._opts.runtime) throw this._runtimeRegistrationError();
      return undefined;
    }
    let info: StoredOAuthClientInformation;
    try {
      info = JSON.parse(stored.value) as StoredOAuthClientInformation;
    } catch (err) {
      this._opts.logger?.warn(
        `stored client information for "${this._opts.serverName}" is not valid JSON — discarding and re-registering`,
        { component: "oauth", error: err instanceof Error ? err.message : String(err) },
      );
      // Self-heal: drop the corrupt entry so the next registration attempt
      // can write a fresh one instead of repeatedly bouncing off this branch.
      await this._opts.store.delete(clientInfoKey(this._opts.serverName));
      if (this._opts.runtime) throw this._runtimeRegistrationError();
      return undefined;
    }
    if (
      this._opts.runtime &&
      ctx?.issuer &&
      info.issuer &&
      !issuersMatch(info.issuer, ctx.issuer)
    ) {
      throw this._runtimeRegistrationError();
    }
    return info as OAuthClientInformationFull;
  }

  private _runtimeRegistrationError(): Error {
    return new ReauthorizationRequiredError(
      `Dynamic client registration is not available at runtime for "${this._opts.serverName}" — ` +
      `run \`${APP_NAME} auth ${this._opts.serverName}\` from a terminal to register and authorize.`,
    );
  }

  async saveClientInformation(info: StoredOAuthClientInformation): Promise<void> {
    if (this._opts.clientId) return;

    if (this._opts.runtime) {
      const stored = parseStoredClientInfo(
        await this._opts.store.get(clientInfoKey(this._opts.serverName)),
      );
      if (isIssuerStampOnly(stored, info)) {
        await this._opts.store.set(clientInfoKey(this._opts.serverName), {
          type: "secret",
          value: JSON.stringify(info),
        });
        return;
      }
      // The runtime provider's `redirectUrl` is portless (the daemon has no
      // listener), so a dynamic registration here would advertise a redirect
      // that the CLI flow's port-bound listener can never match. Refuse and
      // let the SDK surface the auth error so the user runs `mcp-bridge auth`
      // from a CLI, which registers (and persists) with the correct URI.
      throw this._runtimeRegistrationError();
    }
    await this._opts.store.set(clientInfoKey(this._opts.serverName), {
      type: "secret",
      value: JSON.stringify(info),
    });
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    if (this._refreshExhausted) {
      // Force the SDK to take the authorization path, where
      // `redirectToAuthorization` throws a clear "run mcp-bridge auth" error.
      return undefined;
    }
    // Snapshot the invalidate counter BEFORE the await — if invalidate
    // bumps it while `store.get` is in flight, we must not let the stale
    // pre-delete read resurrect the just-cleared cache.
    const epoch = this._invalidateEpoch;
    const cred = await this._opts.store.get(oauthCredentialKey(this._opts.serverName));
    if (!cred || cred.type !== "oauth2") return undefined;

    if (this._invalidateEpoch === epoch) {
      this._lastRefreshToken = cred.refresh_token;
    }

    // If the token is already expired and we have no refresh token, return
    // undefined so the SDK takes the re-authorization path instead of POSTing
    // a guaranteed-401 access token at the upstream.
    if (
      typeof cred.expires_at === "number" &&
      cred.expires_at * 1000 <= Date.now() &&
      !cred.refresh_token
    ) {
      return undefined;
    }

    const expiresIn =
      typeof cred.expires_at === "number"
        ? Math.max(0, cred.expires_at - Math.floor(Date.now() / 1000))
        : undefined;

    return {
      access_token: cred.access_token,
      token_type: cred.token_type ?? "Bearer",
      ...(cred.refresh_token ? { refresh_token: cred.refresh_token } : {}),
      ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}),
      ...(cred.issuer ? { issuer: cred.issuer } : {}),
    };
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    ctx?: OAuthClientInformationContext,
  ): Promise<void> {
    this._refreshFailedTransiently = false;
    const issuer = tokens.issuer ?? ctx?.issuer;
    const expiresAt =
      typeof tokens.expires_in === "number"
        ? Math.floor(Date.now() / 1000) + tokens.expires_in
        : undefined;

    // Preserve refresh_token when the SDK's refresh response omits it.
    // Most IdPs (Google, Slack, …) don't rotate by default and return only
    // `access_token` on refresh. Fallback reads the cache as a sync field
    // access, so no await can interleave with the store.set below.
    const refreshToken = tokens.refresh_token ?? this._lastRefreshToken;
    // Update the cache BEFORE the await. invalidateCredentials also mutates
    // synchronously, so whichever ran first wins consistently — and the
    // file-level mutex serialises this write against any racing delete.
    if (refreshToken) this._lastRefreshToken = refreshToken;

    await this._opts.store.set(oauthCredentialKey(this._opts.serverName), {
      type: "oauth2",
      access_token: tokens.access_token,
      ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      ...(this._opts.clientId ? { client_id: this._opts.clientId } : {}),
      ...(issuer ? { issuer } : {}),
    });

    // Refresh-loop circuit breaker — only meaningful for the runtime provider
    // where unsupervised refreshes could otherwise spin forever.
    if (this._opts.runtime) {
      const now = Date.now();
      this._recentSaves.push(now);
      this._recentSaves = this._recentSaves.filter((t) => now - t <= REFRESH_WINDOW_MS);
      if (this._recentSaves.length > REFRESH_BURST_LIMIT) {
        this._refreshExhausted = true;
        this._opts.logger?.warn(
          `refresh-on-401 circuit breaker tripped for "${this._opts.serverName}" — ` +
          `${this._recentSaves.length} refreshes within ${REFRESH_WINDOW_MS / 1000}s. ` +
          `Run \`${APP_NAME} auth ${this._opts.serverName}\` to re-authorize.`,
          { component: "oauth" },
        );
      }
    }
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this._opts.onRedirect) {
      if (this.refreshFailedTransiently) {
        throw new Error(
          `Could not refresh authorization for "${this._opts.serverName}"; the authorization server may be unreachable.`,
        );
      }
      // Runtime: no interactive user. Reached when the stored refresh_token
      // is permanently invalid (the SDK wiped the tokens after
      // InvalidGrantError), when there are no usable tokens, when the
      // upstream demands a wider scope, or when the refresh-loop circuit
      // breaker tripped.
      throw new ReauthorizationRequiredError(
        `Authentication for "${this._opts.serverName}" expired. ` +
        `Run: ${APP_NAME} auth ${this._opts.serverName}`,
      );
    }
    await this._opts.onRedirect(url);
  }

  /**
   * Wrap a `fetch` implementation so concurrent OAuth refresh-token requests
   * coalesce to a single HTTP call. The SDK's transport calls `auth()` once
   * per 401, so N parallel tool calls hitting an expired access token spawn
   * N parallel `refreshAuthorization` POSTs. With IdPs that rotate refresh
   * tokens (Linear, GitHub, …), only one of those wins and the others
   * either fail or invalidate the just-minted token. Coalescing avoids that
   * race entirely while preserving the SDK's reactive 401 flow.
   *
   * Scope: per-provider instance. Each upstream HTTP server owns its own
   * provider, so dedup is naturally per-server.
   */
  wrapFetch(baseFetch: FetchLike): FetchLike {
    return async (input, init) => {
      if (!isRefreshTokenRequest(init)) return baseFetch(input, init);
      let p = this._refreshFetchPromise;
      if (!p) {
        p = baseFetch(input, init);
        this._refreshFetchPromise = p;
        p.then(
          (response) => {
            this._refreshFailedTransiently = isTransientStatus(response.status);
          },
          () => {
            this._refreshFailedTransiently = true;
          },
        );
        // Clear the slot once the in-flight call settles. Both branches
        // (resolve, reject) drain awaiters; the catch on the cleanup chain
        // is purely to silence the otherwise-unhandled rejection warning
        // that node emits for the bookkeeping chain — every real awaiter
        // still observes the rejection via its own `await p`.
        p.finally(() => {
          if (this._refreshFetchPromise === p) {
            this._refreshFetchPromise = undefined;
          }
        }).catch(() => {});
      }
      // Each awaiter gets its own clone — Response bodies are single-use
      // streams, so we cannot hand the same Response to multiple callers.
      const response = await p;
      return response.clone();
    };
  }

  saveCodeVerifier(verifier: string): void {
    this._verifier = verifier;
  }

  codeVerifier(): string {
    if (!this._verifier) {
      throw new Error("PKCE code verifier missing — authorization flow not started");
    }
    return this._verifier;
  }

  /**
   * CSRF `state` parameter. Generated on first call, memoised for the
   * lifetime of this provider so the CLI flow can read the same value back
   * via `expectedState()` to compare against the callback.
   */
  state(): string {
    if (!this._state) {
      this._state = randomBytes(32).toString("base64url");
    }
    return this._state;
  }

  /** The `state` value previously handed to the SDK, or `undefined` if
   * `state()` has not been invoked. Used by the CLI flow to verify the
   * callback `state` matches what we issued. */
  expectedState(): string | undefined {
    return this._state;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "verifier" || scope === "all") {
      this._verifier = undefined;
    }
    // The SDK calls `invalidateCredentials("verifier")` on token-endpoint
    // errors. Wiping `_state` there would race against the in-flight CLI
    // flow, surfacing the unrelated failure as a confusing "state mismatch".
    // Only the explicit "all" scope clears `_state`.
    if (scope === "all") {
      this._state = undefined;
    }
    if (scope === "tokens" || scope === "all") {
      // Sync mutations before the await so a concurrent saveTokens sees the
      // cleared cache (and doesn't fall back to a stale refresh_token that
      // we're about to delete). Bumping `_invalidateEpoch` also fences any
      // in-flight `tokens()` whose `store.get` resolves after this point
      // from writing the stale read back into the just-cleared cache.
      this._invalidateEpoch++;
      this._lastRefreshToken = undefined;
      this._recentSaves = [];
      this._refreshExhausted = false;
      this._refreshFailedTransiently = false;
      await this._opts.store.delete(oauthCredentialKey(this._opts.serverName));
    }
    if (scope === "client" || scope === "all") {
      if (this._opts.clientId) {
        await this._opts.store.delete(clientIssuerKey(this._opts.serverName));
      } else {
        await this._opts.store.delete(clientInfoKey(this._opts.serverName));
      }
    }
    if (scope === "discovery" || scope === "all") {
      this._discoveryState = undefined;
    }
  }
}
