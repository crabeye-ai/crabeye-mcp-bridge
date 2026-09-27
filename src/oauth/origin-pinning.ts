import { OAuthError } from "./errors.js";

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
