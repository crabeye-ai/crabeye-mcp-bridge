import type { SearchQuery } from "./types.js";

/** At most this many queries in one `search_tools` call. */
const MAX_SEARCH_QUERIES = 64;

/** At most this many UTF-8 bytes in a query's `tool`, `provider` or `category`. */
const MAX_SEARCH_TERM_BYTES = 1024;

/** The query fields that hold search terms. */
export const SEARCH_TERMS = ["tool", "provider", "category"] as const;

/** A regex longer than this many characters is searched as plain text. */
export const MAX_REGEX_LEN = 200;

/** A word is searched by this many of its first characters, which bounds how deep a fuzzy search can go. */
export const MAX_SEARCHED_WORD_CHARS = 64;

/** A tool whose own name is longer than this many bytes isn't searchable; the manager refuses to call it anyway. */
export const MAX_SEARCHED_NAME_BYTES = 1024;

/** Only this many characters of a tool's description are searched, so a huge description can't make one test outlast the time limit. */
export const MAX_SEARCHED_DESCRIPTION_CHARS = 16_384;

/** Tool results a query returns when it sets no `limit`. */
export const DEFAULT_LIMIT = 10;

/** At most this many tool results per query. */
export const MAX_LIMIT = 50;

/** A search that runs longer than this stops with an error, so it can't hold up everything else the manager does. */
export const SEARCH_TIME_LIMIT_MS = 2_000;

/** A search ran past its time limit. */
export class SearchTimeoutError extends Error {
  constructor(limitMs: number) {
    super(`search took longer than ${limitMs / 1000} seconds; use simpler regexes or fewer queries`);
    this.name = "SearchTimeoutError";
  }
}

/** A check that throws `SearchTimeoutError` once `limitMs` have passed since it was made. */
export function timeLimit(limitMs: number): () => void {
  const until = performance.now() + limitMs;
  return () => {
    if (performance.now() > until) throw new SearchTimeoutError(limitMs);
  };
}

/** What makes a search's queries unacceptable, or null when they are fine. */
export function searchQueriesProblem(queries: readonly SearchQuery[]): string | null {
  if (queries.length === 0) return "'queries' must be a non-empty array of query objects.";
  if (queries.length > MAX_SEARCH_QUERIES) return `at most ${MAX_SEARCH_QUERIES} queries per search.`;
  for (const [i, query] of queries.entries()) {
    if (!query.tool && !query.provider && !query.category) return `queries[${i}] must have at least one of 'tool', 'provider', or 'category'.`;
    const tooLong = SEARCH_TERMS.find((term) => Buffer.byteLength(query[term] ?? "") > MAX_SEARCH_TERM_BYTES);
    if (tooLong !== undefined) return `queries[${i}].${tooLong} is longer than ${MAX_SEARCH_TERM_BYTES} bytes.`;
  }
  return null;
}
