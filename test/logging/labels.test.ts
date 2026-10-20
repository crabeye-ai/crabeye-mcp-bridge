import { describe, it, expect } from "vitest";
import { escapeLabel, methodLabel } from "../../src/logging/labels.js";

const FORMAT_CHARACTERS = ["061c", "200b", "200c", "200d", "200e", "200f", "202a", "202b", "202c", "202d", "202e", "2060", "2066", "2067", "2068", "2069", "feff"];

describe("methodLabel", () => {
  it.each([
    ["roots/list", "roots/list"],
    ["m".repeat(64), "m".repeat(64)],
    ["m".repeat(65), `${"m".repeat(64)}…`],
    [`a${String.fromCodePoint(0x1b)}[2J`, "a\\x1b[2J"],
    [`a${String.fromCodePoint(0x9b)}b`, "a\\x9bb"],
    [`a${String.fromCodePoint(0x202e)}b${String.fromCodePoint(0x2066)}c${String.fromCodePoint(0x200f)}`, "a\\u202eb\\u2066c\\u200f"],
    [`${"m".repeat(63)}${String.fromCodePoint(0x1f980)}`, `${"m".repeat(63)}…`],
    [`${"m".repeat(62)}${String.fromCodePoint(0x1f980)}x`, `${"m".repeat(62)}${String.fromCodePoint(0x1f980)}…`],
    [`ok${String.fromCodePoint(0xe9)}`, `ok${String.fromCodePoint(0xe9)}`],
  ])("shows %j as %s", (method, label) => {
    expect(methodLabel(method)).toBe(label);
  });
});

describe("escapeLabel", () => {
  it.each(FORMAT_CHARACTERS)("escapes the invisible format character U+%s as a four-digit \\u escape", (hex) => {
    expect(escapeLabel(`a${String.fromCodePoint(parseInt(hex, 16))}b`)).toBe(`a\\u${hex}b`);
  });

  it.each(["034f", "115f", "3164", "ffa0", "fe0f", "2800"])("escapes the invisible U+%s that isn't a format character", (hex) => {
    expect(escapeLabel(`a${String.fromCodePoint(parseInt(hex, 16))}b`)).toBe(`a\\u${hex}b`);
  });

  it("escapes a variation selector outside the basic plane by its code point", () => {
    expect(escapeLabel(`a${String.fromCodePoint(0xe0100)}b`)).toBe("a\\u{e0100}b");
  });

  it("escapes a soft hyphen as a two-digit \\x escape, like the logger does below U+0100", () => {
    expect(escapeLabel(`a${String.fromCodePoint(0xad)}b`)).toBe("a\\xadb");
  });

  it("escapes a tag character outside the basic plane by its code point", () => {
    expect(escapeLabel(`a${String.fromCodePoint(0xe0041)}b`)).toBe("a\\u{e0041}b");
  });

  it("leaves printable text, including non-ASCII letters and emoji, as it is", () => {
    const text = `r${String.fromCodePoint(0xe9)}sum${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x1f980)} \\u0041`;

    expect(escapeLabel(text)).toBe(text);
  });
});
