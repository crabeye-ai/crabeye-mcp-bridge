import v8 from "node:v8";
import { MAX_REGEX_LEN } from "./limits.js";

const HEX_ESCAPE = /^\\(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/;
const UNICODE_PROPERTY_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\[pP]\{/;
const UPPER_CASE_ESCAPES = new Set(["B", "D", "S", "W"]);

let linearEngineEnabled = false;

/**
 * Lets search regexes run on V8's linear-time engine (the `l` flag), so no
 * search can stall the process however its pattern would backtrack. That
 * engine takes no `i`, `u` or `v` flag and no backreference, lookahead or
 * large bounded repeat; a pattern it can't run isn't treated as a regex.
 */
function enableLinearEngine(): void {
  if (linearEngineEnabled) return;
  v8.setFlagsFromString("--enable-experimental-regexp-engine");
  linearEngineEnabled = true;
}

export interface Pattern {
  test(value: string): boolean;
}

/**
 * A `regex:pattern`, or a `/pattern/flags` with flags among `gimsy`, that runs
 * in linear time; null when the input isn't one, is over 200 characters, or
 * can't run in linear time. `i` matches lower-cased text with a lower-cased
 * pattern; `g` and `y` are ignored. `beforeTest` runs before each test, to
 * stop a search that takes too long.
 */
export function parseRegex(input: string, beforeTest: () => void = () => {}): Pattern | null {
  let pattern: string;
  let flags = "";

  if (input.startsWith("regex:")) {
    pattern = input.slice(6);
  } else {
    const match = /^\/(.+)\/([gimsy]*)$/.exec(input);
    if (!match) return null;
    pattern = match[1];
    flags = match[2];
  }

  if (!pattern || pattern.length > MAX_REGEX_LEN || UNICODE_PROPERTY_ESCAPE.test(pattern)) return null;

  enableLinearEngine();
  const ignoreCase = flags.includes("i");
  let regex: RegExp;
  try {
    regex = new RegExp(ignoreCase ? lowerCasePattern(pattern) : pattern, `${flags.replace(/[giy]/g, "")}l`);
  } catch {
    return null;
  }
  return {
    test: (value) => {
      beforeTest();
      return regex.test(ignoreCase ? foldCase(value) : value);
    },
  };
}

/** Lower-cases text as `/…/i` compares it, with a word-final ς folded to σ. */
function foldCase(text: string): string {
  return text.toLowerCase().replace(/ς/g, "σ");
}

function lowerCasePattern(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const hex = HEX_ESCAPE.exec(pattern.slice(i))?.[0];
    if (hex !== undefined) {
      out += lowerCaseHexEscape(hex);
      i += hex.length;
      continue;
    }
    const char = String.fromCodePoint(pattern.codePointAt(i)!);
    if (char !== "\\" || i + 1 >= pattern.length) {
      out += foldCase(char);
      i += char.length;
      continue;
    }
    const escaped = String.fromCodePoint(pattern.codePointAt(i + 1)!);
    out += escaped !== escaped.toLowerCase() && !UPPER_CASE_ESCAPES.has(escaped) ? foldCase(escaped) : `\\${escaped}`;
    i += 1 + escaped.length;
  }
  return out;
}

function lowerCaseHexEscape(escape: string): string {
  const char = String.fromCharCode(Number.parseInt(escape.slice(2), 16));
  const lower = foldCase(char);
  return lower.length === 1 && lower !== char ? `\\u${lower.charCodeAt(0).toString(16).padStart(4, "0")}` : escape;
}

/** Matches `pattern` as a regex, or else as a prefix ignoring case. */
export function prefixOrRegex(pattern: string, beforeTest?: () => void): Pattern {
  const regex = parseRegex(pattern, beforeTest);
  if (regex) return regex;
  const prefix = pattern.toLowerCase();
  return { test: (value) => value.toLowerCase().startsWith(prefix) };
}
