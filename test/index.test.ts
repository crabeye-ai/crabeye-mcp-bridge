import { describe, it, expect } from "vitest";

describe("kokuai-bridge", () => {
  it("can import the CLI module", async () => {
    const mod = await import("../src/index.js");
    expect(mod).toBeDefined();
  });
});
