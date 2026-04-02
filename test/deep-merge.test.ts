import { describe, it, expect } from "vitest";
import { deepMerge } from "../src/config/deep-merge.js";

type Json = Record<string, unknown>;

describe("deepMerge", () => {
  it("merges flat objects", () => {
    expect(deepMerge({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("later source wins on primitive conflict", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  it("recursively merges nested objects", () => {
    const a: Json = { x: { a: 1, b: 2 } };
    const b: Json = { x: { b: 3, c: 4 } };
    expect(deepMerge(a, b)).toEqual({ x: { a: 1, b: 3, c: 4 } });
  });

  it("arrays use last-wins (no concat)", () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  it("skips undefined sources", () => {
    expect(deepMerge({ a: 1 }, undefined, { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("handles three-way merge", () => {
    const a: Json = { x: { a: 1 } };
    const b: Json = { x: { b: 2 } };
    const c: Json = { x: { c: 3 } };
    expect(deepMerge(a, b, c)).toEqual({ x: { a: 1, b: 2, c: 3 } });
  });

  it("does not merge array with object", () => {
    expect(deepMerge({ a: [1] }, { a: { x: 1 } })).toEqual({ a: { x: 1 } });
  });

  it("handles empty sources", () => {
    expect(deepMerge({}, {})).toEqual({});
  });

  it("deep merges _bridge overlay", () => {
    const clientServer: Json = {
      linear: {
        command: "npx",
        args: ["-y", "@anthropic/linear-mcp-server"],
      },
    };
    const bridgeOverlay: Json = {
      linear: {
        _bridge: { category: "project management" },
      },
    };
    const result = deepMerge(clientServer, bridgeOverlay);
    expect(result).toEqual({
      linear: {
        command: "npx",
        args: ["-y", "@anthropic/linear-mcp-server"],
        _bridge: { category: "project management" },
      },
    });
  });
});
