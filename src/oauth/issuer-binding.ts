import { IssuerMismatchError, type OAuthDiscoveryState, type StoredOAuthClientInformation } from "@modelcontextprotocol/client";
import type { Credential } from "../credentials/types.js";

export function parseStoredClientInfo(
  stored: Credential | undefined,
): StoredOAuthClientInformation | undefined {
  if (stored?.type !== "secret") return undefined;
  try {
    return JSON.parse(stored.value) as StoredOAuthClientInformation;
  } catch {
    return undefined;
  }
}

export function isIssuerStampOnly(
  stored: StoredOAuthClientInformation | undefined,
  info: StoredOAuthClientInformation,
): boolean {
  if (!stored || typeof info.issuer !== "string") return false;
  if (stored.issuer !== undefined) {
    return JSON.stringify(stored) === JSON.stringify(info);
  }
  return JSON.stringify({ ...stored, issuer: info.issuer }) === JSON.stringify(info);
}

export function issuersMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith("/") && a.slice(0, -1) === b) return true;
  if (b.endsWith("/") && b.slice(0, -1) === a) return true;
  return false;
}

/** Whether two possibly missing issuers name the same authorization server: both missing, or both present and matching. */
export function sameIssuer(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return issuersMatch(a, b);
}

/**
 * Whether tokens stamped with `storedIssuer` may be overwritten by tokens
 * stamped with `newIssuer`: an unstamped entry accepts any issuer, a stamped
 * one only the same issuer.
 */
export function issuerAllows(storedIssuer: string | undefined, newIssuer: string | undefined): boolean {
  return storedIssuer === undefined || (newIssuer !== undefined && issuersMatch(storedIssuer, newIssuer));
}

export function assertCallbackIssuerWithoutMetadata(
  discovery: OAuthDiscoveryState | undefined,
  iss: string | undefined,
): void {
  if (iss === undefined || !discovery || discovery.authorizationServerMetadata) return;
  if (!issuersMatch(discovery.authorizationServerUrl, iss)) {
    throw new IssuerMismatchError("authorization_response", discovery.authorizationServerUrl, iss);
  }
}
