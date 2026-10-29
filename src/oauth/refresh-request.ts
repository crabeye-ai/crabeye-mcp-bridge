export interface RefreshRequest {
  refreshToken: string | undefined;
}

/**
 * Describes `init` when it is an OAuth 2.0 refresh-token request: a POST whose
 * form body carries `grant_type=refresh_token`. The SDK builds token requests
 * with a `URLSearchParams` body, so other bodies (such as the JSON of an MCP
 * request) are never taken for one.
 */
export function refreshRequestOf(init: RequestInit | undefined): RefreshRequest | undefined {
  if (init?.method?.toUpperCase() !== "POST" || !(init.body instanceof URLSearchParams)) return undefined;
  if (init.body.get("grant_type") !== "refresh_token") return undefined;
  return { refreshToken: init.body.get("refresh_token") ?? undefined };
}
