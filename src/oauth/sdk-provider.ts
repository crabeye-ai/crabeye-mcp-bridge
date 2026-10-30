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
import type { ConditionalChange, CredentialStore } from "../credentials/credential-store.js";
import { isSendableHeaderValue } from "../credentials/resolve-templates.js";
import type { OAuth2Credential } from "../credentials/types.js";
import type { Logger } from "../logging/index.js";
import { clientInfoKey, clientIssuerKey, oauthCredentialKey } from "./client-secret.js";
import { OAuthError, ReauthorizationRequiredError } from "./errors.js";
import { RefreshTracker, type FetchLike } from "./refresh-tracker.js";
import type { PendingSaves } from "./pending-saves.js";
import type { SharedRefreshes } from "./shared-refreshes.js";
import { RepeatedSaves } from "./repeated-saves.js";
import { TokenWrites, type TokenOrigin } from "./token-writes.js";
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
  /** Refreshes shared with other providers, so the same refresh token is redeemed once among them. Defaults to this provider's own. */
  refreshes?: SharedRefreshes;
  /** Counts this provider's refreshes until their tokens are saved. Defaults to its own. */
  pendingSaves?: PendingSaves;
  /**
   * Aborts once the stored credentials changed elsewhere and this provider's
   * connection is being replaced: the provider then starts no more refreshes
   * and changes nothing stored, except that a refresh already under way may
   * still save its tokens over the very tokens it refreshed.
   */
  retirement?: AbortSignal;
}

// Refresh-loop circuit breaker: a runtime provider saving tokens more than this
// many times within the window is exhausted, so the SDK surfaces the
// `auth <server>` message instead of hammering the token endpoint.
const REFRESH_WINDOW_MS = 60_000;
const REFRESH_BURST_LIMIT = 6;

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
  private readonly _refreshTracker: RefreshTracker;
  private readonly _tokenWrites: TokenWrites;
  // Sync mirror of the stored credential's refresh_token. Lets `saveTokens`
  // preserve it on non-rotating IdPs without an async re-read, closing the
  // saveTokens-vs-invalidateCredentials TOCTOU.
  private _lastRefreshToken: string | undefined;
  // Monotonic counter bumped by `invalidateCredentials` for token-clearing
  // scopes. `tokens()` snapshots it before its `await store.get(...)` and
  // refuses to write the cache from a stale read whose result predates a
  // concurrent invalidate.
  private _invalidateEpoch = 0;
  private readonly _repeatedSaves = new RepeatedSaves();
  private _discoveryState: OAuthDiscoveryState | undefined;

  get refreshFailedTransiently(): boolean {
    return this._refreshTracker.lastRefreshFailedTransiently && !this._refreshExhausted;
  }

  constructor(opts: BridgeOAuthProviderOptions) {
    this._opts = opts;
    this._refreshTracker = new RefreshTracker(opts.refreshes, opts.pendingSaves);
    this._tokenWrites = new TokenWrites({ store: opts.store, serverName: opts.serverName, logger: opts.logger });
  }

  private get _retired(): boolean {
    return this._opts.retirement?.aborted === true;
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
      application_type: "native",
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
      if (ctx?.issuer && !recorded && !this._retired) {
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
      if (!this._retired) await this._opts.store.delete(clientInfoKey(this._opts.serverName));
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
    if (this._opts.clientId || this._retired) return;

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
    if (this._refreshExhausted || this._retired) {
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

    this._tokenWrites.rememberRead({ access_token: cred.access_token, refresh_token: cred.refresh_token });
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

    if (!isSendableHeaderValue(`Bearer ${cred.access_token}`)) {
      if (!this._opts.runtime) return undefined;
      throw new ReauthorizationRequiredError(
        `The stored access token for "${this._opts.serverName}" can't be sent in a header. ` +
        `Run: ${APP_NAME} auth ${this._opts.serverName}`,
      );
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

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    try {
      await this._saveTokens(tokens, ctx);
    } finally {
      this._refreshTracker.saveFinished(tokens.access_token);
    }
  }

  private async _saveTokens(tokens: StoredOAuthTokens, ctx: OAuthClientInformationContext | undefined): Promise<void> {
    this._refreshTracker.clearTransientFailure();
    if (!isSendableHeaderValue(`Bearer ${tokens.access_token}`)) {
      throw new OAuthError(
        "invalid_token",
        `The authorization server for "${this._opts.serverName}" issued an access token that can't be sent in a header.`,
      );
    }
    const issuer = tokens.issuer ?? ctx?.issuer;
    const expiresAt =
      typeof tokens.expires_in === "number"
        ? Math.floor(Date.now() / 1000) + tokens.expires_in
        : undefined;

    // Preserve refresh_token when the SDK's refresh response omits it.
    // Most IdPs (Google, Slack, …) don't rotate by default and return only
    // `access_token` on refresh. Fallback reads the cache as a sync field
    // access, so no await can interleave with the write below.
    const refreshToken = tokens.refresh_token ?? this._lastRefreshToken;
    // Update the cache BEFORE the await. invalidateCredentials also mutates
    // synchronously, so whichever ran first wins consistently — and the
    // file-level mutex serialises this write against any racing delete.
    if (refreshToken) this._lastRefreshToken = refreshToken;

    const credential: OAuth2Credential = {
      type: "oauth2",
      access_token: tokens.access_token,
      ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      ...(this._opts.clientId ? { client_id: this._opts.clientId } : {}),
      ...(issuer ? { issuer } : {}),
    };
    const origin: TokenOrigin = { redeemed: this._refreshTracker.redeemedFor(tokens.access_token), addIfMissing: !this._retired };
    if (await this._repeatedSaves.saveOnce(credential, () => this._write(credential, origin))) this._countRefresh();
  }

  private async _write(credential: OAuth2Credential, origin: TokenOrigin): Promise<void> {
    const dropped = this._retired && origin.redeemed === undefined;
    if (dropped || !(await this._tokenWrites.write(credential, origin))) this._logDroppedRefresh();
  }

  private _logDroppedRefresh(): void {
    this._opts.logger?.info(`dropped the tokens of a refresh for "${this._opts.serverName}" after the stored tokens changed`, { component: "oauth" });
  }

  private _countRefresh(): void {
    // Refresh-loop circuit breaker, counting every save of new tokens — only meaningful
    // for the runtime provider, where unsupervised refreshes could otherwise spin forever.
    if (!this._opts.runtime) return;
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

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this._opts.onRedirect) {
      if (this.refreshFailedTransiently) {
        throw new Error(
          `Could not refresh authorization for "${this._opts.serverName}"; the authorization server may be unreachable.`,
        );
      }
      // Runtime: no interactive user. Reached when the stored refresh_token
      // is permanently invalid (the tokens were deleted after the
      // authorization server rejected it), when there are no usable tokens,
      // when the upstream demands a wider scope, or when the refresh-loop
      // circuit breaker tripped.
      throw new ReauthorizationRequiredError(
        `Authentication for "${this._opts.serverName}" expired. ` +
        `Run: ${APP_NAME} auth ${this._opts.serverName}`,
      );
    }
    await this._opts.onRedirect(url);
  }

  /**
   * Wrap a `fetch` so concurrent refreshes of the same refresh token coalesce
   * to one token-endpoint call, also with the other providers sharing the
   * `refreshes` option, and so the provider learns which refresh tokens the
   * authorization server rejected and which one each refresh redeemed. Every
   * fetch the SDK uses for this provider's token endpoint must go through it.
   */
  wrapFetch(baseFetch: FetchLike): FetchLike {
    return this._refreshTracker.wrap(baseFetch);
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

  private _deleteTokens({ keepTokensRefreshedElsewhere }: { keepTokensRefreshedElsewhere: boolean }): Promise<ConditionalChange<"deleted">> {
    const tracker = this._refreshTracker;
    if (!keepTokensRefreshedElsewhere || !tracker.hasRejections()) return this._tokenWrites.delete();
    return this._tokenWrites.deleteRefused((refreshToken) => tracker.wasRejected(refreshToken));
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (this._retired) return;
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
      // may be about to be deleted). Bumping `_invalidateEpoch` also fences
      // any in-flight `tokens()` whose `store.get` resolves after this point
      // from writing the stale read back into the just-cleared cache.
      this._invalidateEpoch++;
      this._lastRefreshToken = undefined;
      this._refreshTracker.clearTransientFailure();
      const outcome = await this._deleteTokens({ keepTokensRefreshedElsewhere: scope === "tokens" });
      if (outcome !== "kept") {
        this._recentSaves = [];
        this._refreshExhausted = false;
      }
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
