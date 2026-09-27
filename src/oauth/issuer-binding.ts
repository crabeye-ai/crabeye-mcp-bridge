import type { StoredOAuthClientInformation } from "@modelcontextprotocol/client";
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
