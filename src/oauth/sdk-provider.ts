import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { APP_NAME, APP_VERSION } from "../constants.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import type { Logger } from "../logging/index.js";
import { clientInfoKey, oauthCredentialKey } from "./client-secret.js";
import { OAuthError } from "./errors.js";

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

  constructor(opts: BridgeOAuthProviderOptions) {
    this._opts = opts;
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

  async clientInformation(): Promise<
    OAuthClientInformation | OAuthClientInformationFull | undefined
  > {
    if (this._opts.clientId) {
      return {
        client_id: this._opts.clientId,
        ...(this._opts.clientSecret ? { client_secret: this._opts.clientSecret } : {}),
      };
    }
    const stored = await this._opts.store.get(clientInfoKey(this._opts.serverName));
    if (!stored || stored.type !== "secret") return undefined;
    try {
      return JSON.parse(stored.value) as OAuthClientInformationFull;
    } catch (err) {
      this._opts.logger?.warn(
        `stored client information for "${this._opts.serverName}" is not valid JSON — discarding and re-registering`,
        { component: "oauth", error: err instanceof Error ? err.message : String(err) },
      );
      // Self-heal: drop the corrupt entry so the next registration attempt
      // can write a fresh one instead of repeatedly bouncing off this branch.
      await this._opts.store.delete(clientInfoKey(this._opts.serverName));
      return undefined;
    }
  }

  async saveClientInformation(
    info: OAuthClientInformation | OAuthClientInformationFull,
  ): Promise<void> {
    if (this._opts.runtime) {
      // The runtime provider's `redirectUrl` is portless (the daemon has no
      // listener), so a dynamic registration here would advertise a redirect
      // that the CLI flow's port-bound listener can never match. Refuse and
      // let the SDK surface the auth error so the user runs `mcp-bridge auth`
      // from a CLI, which registers (and persists) with the correct URI.
      throw new Error(
        `Dynamic client registration is not available at runtime for "${this._opts.serverName}" — ` +
        `run \`${APP_NAME} auth ${this._opts.serverName}\` from a terminal to register and authorize.`,
      );
    }
    await this._opts.store.set(clientInfoKey(this._opts.serverName), {
      type: "secret",
      value: JSON.stringify(info),
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this._refreshExhausted) {
      // Force the SDK to take the authorization path, where
      // `redirectToAuthorization` throws a clear "run mcp-bridge auth" error.
      return undefined;
    }
    const cred = await this._opts.store.get(oauthCredentialKey(this._opts.serverName));
    if (!cred || cred.type !== "oauth2") return undefined;

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
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expiresAt =
      typeof tokens.expires_in === "number"
        ? Math.floor(Date.now() / 1000) + tokens.expires_in
        : undefined;

    await this._opts.store.set(oauthCredentialKey(this._opts.serverName), {
      type: "oauth2",
      access_token: tokens.access_token,
      ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      ...(this._opts.clientId ? { client_id: this._opts.clientId } : {}),
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
      throw new Error(
        `OAuth authorization required for "${this._opts.serverName}" — ` +
        `run \`${APP_NAME} auth ${this._opts.serverName}\``,
      );
    }
    await this._opts.onRedirect(url);
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
      await this._opts.store.delete(oauthCredentialKey(this._opts.serverName));
      this._recentSaves = [];
      this._refreshExhausted = false;
    }
    if (scope === "client" || scope === "all") {
      // Only invalidate dynamically-registered client info, never config-supplied.
      if (!this._opts.clientId) {
        await this._opts.store.delete(clientInfoKey(this._opts.serverName));
      }
    }
  }
}

type FetchLike = typeof fetch;

/**
 * Wraps `fetch` so RFC 8414 / 9728 metadata responses are inspected for
 * `authorization_endpoint` + `token_endpoint` and the two are pinned to the
 * same origin. A tampered AS metadata response that points the token endpoint
 * at an attacker-controlled origin would otherwise let the SDK POST the
 * authorization code + PKCE verifier + client_secret to that host.
 *
 * Non-JSON responses, opaque errors, and metadata without both fields pass
 * through unchanged. Origin mismatch throws `OAuthError` so the whole `auth()`
 * call rejects before any token-exchange POST.
 */
export function makeOriginPinningFetch(baseFetch: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!response.ok) return response;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) return response;

    let body: unknown;
    try {
      body = await response.clone().json();
    } catch {
      return response;
    }
    if (!body || typeof body !== "object") return response;
    const obj = body as Record<string, unknown>;
    const auth =
      typeof obj.authorization_endpoint === "string" ? obj.authorization_endpoint : undefined;
    const tok =
      typeof obj.token_endpoint === "string" ? obj.token_endpoint : undefined;
    if (!auth || !tok) return response;

    let authOrigin: string;
    let tokOrigin: string;
    try {
      authOrigin = new URL(auth).origin;
      tokOrigin = new URL(tok).origin;
    } catch {
      return response;
    }
    if (authOrigin !== tokOrigin) {
      throw new OAuthError(
        "token_endpoint_origin_mismatch",
        `Token endpoint origin (${tokOrigin}) does not match authorization endpoint origin (${authOrigin}). ` +
          `Refusing to exchange the authorization code at a non-AS origin.`,
      );
    }
    return response;
  };
}
