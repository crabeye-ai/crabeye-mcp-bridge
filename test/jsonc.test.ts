import { describe, it, expect } from "vitest";
import { parseJsoncString } from "../src/config/jsonc.js";

describe("parseJsoncString", () => {
  it("parses standard JSON", () => {
    expect(parseJsoncString('{"a": 1}')).toEqual({ a: 1 });
  });

  it("parses JSONC with line comments", () => {
    const input = `{
      // this is a comment
      "a": 1
    }`;
    expect(parseJsoncString(input)).toEqual({ a: 1 });
  });

  it("parses JSONC with block comments", () => {
    const input = `{
      /* block comment */
      "a": 1
    }`;
    expect(parseJsoncString(input)).toEqual({ a: 1 });
  });

  it("parses JSONC with trailing commas", () => {
    const input = `{
      "a": 1,
      "b": 2,
    }`;
    expect(parseJsoncString(input)).toEqual({ a: 1, b: 2 });
  });

  it("throws SyntaxError on truly invalid syntax", () => {
    expect(() => parseJsoncString("{bad")).toThrow(SyntaxError);
  });

  it("throws on empty string", () => {
    expect(() => parseJsoncString("")).toThrow(SyntaxError);
  });

  it("parses arrays", () => {
    expect(parseJsoncString("[1, 2, 3]")).toEqual([1, 2, 3]);
  });
});
