import { INVISIBLE_CHARACTERS } from "../logging/escape.js";
import type { SearchQuery, SearchToolsResponse } from "../search/types.js";

export const TRUNCATION_MARKER = "\n…(truncated)";

/**
 * Hard ceiling on a server's instructions, applied even when the user did
 * not set `_bridge.passthroughMaxBytes`. A misbehaving upstream returning a
 * multi-MiB `instructions` string would otherwise be shipped with every
 * search that asks for it.
 */
const HARD_CAP_BYTES = 256 * 1024;

/**
 * A server's instructions as a search returns them: without control or
 * invisible characters, capped at `maxBytes` and never above 256 KiB, or
 * undefined when nothing is left.
 */
export function passthroughInstructions(instructions: string, maxBytes: number | undefined): string | undefined {
  const text = sanitize(instructions);
  if (text === "") return undefined;
  return capBytes(text, Math.min(maxBytes ?? HARD_CAP_BYTES, HARD_CAP_BYTES));
}

/**
 * Adds each server's instructions to its first entry under a query that set
 * `include_instructions`, and `has_instructions` to each of its entries
 * before that one; later entries get neither. `instructionsOf` gives what
 * `passthroughInstructions` returns for a server with passthrough on, and
 * undefined for any other; it is asked once per server.
 */
export function withInstructions(
  response: SearchToolsResponse,
  queries: ReadonlyArray<SearchQuery>,
  instructionsOf: (server: string) => string | undefined,
): SearchToolsResponse {
  const given = new Set<string>();
  const fetched = new Map<string, string | undefined>();
  const results = response.results.map((result, at) => ({
    ...result,
    providers: result.providers.map((provider) => {
      if (given.has(provider.name)) return provider;
      if (!fetched.has(provider.name)) fetched.set(provider.name, instructionsOf(provider.name));
      const instructions = fetched.get(provider.name);
      if (instructions === undefined) return provider;
      if (queries[at]?.include_instructions !== true) return { ...provider, has_instructions: true as const };
      given.add(provider.name);
      return { ...provider, instructions };
    }),
  }));
  return { ...response, results };
}

const LONE_SURROGATES = /\p{Cs}/gu;
const CONTROLS_BUT_NEWLINE_AND_TAB = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028\u2029]/g;

function sanitize(s: string): string {
  return s.replace(LONE_SURROGATES, "").replace(CONTROLS_BUT_NEWLINE_AND_TAB, "").replace(INVISIBLE_CHARACTERS, "");
}

function capBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf-8");
  if (buf.byteLength <= maxBytes) return s;
  let cut = maxBytes;
  // `subarray(0, cut)` excludes `buf[cut]`. Walk back while `buf[cut]` is a
  // UTF-8 continuation byte (10xxxxxx) so we don't slice in the middle of a
  // multi-byte codepoint. ASCII (0xxxxxxx) and lead bytes (11xxxxxx) sit at
  // the START of a codepoint and therefore at the END of the slice — both
  // are valid stop positions.
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf-8") + TRUNCATION_MARKER;
}
