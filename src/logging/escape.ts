const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
const NAMED_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

function hexEscape(code: number): string {
  if (code > 0xffff) return `\\u{${code.toString(16)}}`;
  return code > 0xff
    ? `\\u${code.toString(16).padStart(4, "0")}`
    : `\\x${code.toString(16).padStart(2, "0")}`;
}

/** Replaces every match of a global `pattern` with its `\n`/`\r`/`\t` name or a `\xNN`, `\uNNNN` or `\u{...}` escape. */
export function escapeMatching(text: string, pattern: RegExp): string {
  return text.replace(pattern, (char) => NAMED_ESCAPES[char] ?? hexEscape(char.codePointAt(0)!));
}

export function escapeControlCharacters(text: string): string {
  return escapeMatching(text, CONTROL_CHARACTERS);
}
