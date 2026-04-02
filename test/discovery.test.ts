import { describe, it, expect } from "vitest";
import { discoverMcpConfigs } from "../src/config/discovery.js";

describe("discoverMcpConfigs", () => {
  it("returns an array", async () => {
    const results = await discoverMcpConfigs();
    expect(Array.isArray(results)).toBe(true);
  });

  it("each entry has clientName and path", async () => {
    const results = await discoverMcpConfigs();
    for (const entry of results) {
      expect(entry).toHaveProperty("clientName");
      expect(entry).toHaveProperty("path");
      expect(typeof entry.clientName).toBe("string");
      expect(typeof entry.path).toBe("string");
    }
  });
});
