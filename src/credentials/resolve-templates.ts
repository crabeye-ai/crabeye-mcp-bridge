import type { CredentialStore } from "./credential-store.js";
import { CredentialError } from "./errors.js";
import { resolveCredentialValue } from "./types.js";

const TEMPLATE_RE = /\$\{credential:([^}]+)\}/g;
const TEMPLATE_TEST_RE = /\$\{credential:[^}]+\}/;

/** Fast check: does any value in the record contain a `${credential:...}` template? */
export function hasCredentialTemplates(
  record: Record<string, string> | undefined,
): boolean {
  if (!record) return false;
  for (const value of Object.values(record)) {
    if (TEMPLATE_TEST_RE.test(value)) return true;
  }
  return false;
}

/**
 * Replace all `${credential:key}` templates in a string→string record.
 * Supports mixed content (e.g. `"Bearer ${credential:token}"`) and
 * multiple templates per value.
 *
 * Uses index-based replacement (processed in reverse) to avoid
 * `String.replace` interpreting `$`-patterns in credential values
 * and to handle duplicate templates correctly.
 */
export async function resolveCredentialTemplates(
  record: Record<string, string>,
  store: CredentialStore,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(record)) {
    const matches = [...value.matchAll(TEMPLATE_RE)];
    if (matches.length === 0) {
      resolved[key] = value;
      continue;
    }

    // Resolve all credentials first (fail-fast on missing keys)
    const replacements: Array<{ start: number; end: number; resolved: string }> = [];
    for (const match of matches) {
      const credKey = match[1];
      const credential = await store.get(credKey);
      if (!credential) {
        throw new CredentialError(
          `Credential "${credKey}" not found in credential store`,
        );
      }
      replacements.push({
        start: match.index!,
        end: match.index! + match[0].length,
        resolved: resolveCredentialValue(credential),
      });
    }

    // Apply in reverse so earlier indices stay valid
    let result = value;
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { start, end, resolved: val } = replacements[i];
      result = result.slice(0, start) + val + result.slice(end);
    }
    resolved[key] = result;
  }

  return resolved;
}
