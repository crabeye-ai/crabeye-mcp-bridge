import { escapeControlCharacters, escapeMatching } from "./escape.js";

const MAX_METHOD_LABEL_LENGTH = 64;
const INVISIBLE_CHARACTERS = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu;
const LONE_HIGH_SURROGATE_AT_END = /[\ud800-\udbff]$/;

/** Escapes control and invisible characters (bidi, zero-width, variation selectors, fillers, tags) so the text prints as it reads. */
export function escapeLabel(text: string): string {
  return escapeMatching(escapeControlCharacters(text), INVISIBLE_CHARACTERS);
}

export function methodLabel(method: string): string {
  const shown =
    method.length > MAX_METHOD_LABEL_LENGTH
      ? `${method.slice(0, MAX_METHOD_LABEL_LENGTH).replace(LONE_HIGH_SURROGATE_AT_END, "")}…`
      : method;
  return escapeLabel(shown);
}
