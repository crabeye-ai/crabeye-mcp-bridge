import { parse as parseJsonc, type ParseError } from "jsonc-parser";

export function parseJsoncString(text: string): unknown {
  const errors: ParseError[] = [];
  const result = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new SyntaxError("Invalid JSONC");
  }
  return result;
}
