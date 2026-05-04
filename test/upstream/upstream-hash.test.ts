import { describe, it, expect } from "vitest";
import { upstreamHash, type UpstreamSpec } from "../../src/upstream/upstream-hash.js";

const baseSpec: UpstreamSpec = {
  serverName: "linear",
  command: "node",
  args: ["./linear-mcp.js"],
  resolvedEnv: { TOKEN: "abc" },
  cwd: "",
};

describe("upstreamHash", () => {
  it("is deterministic for the same spec", () => {
    expect(upstreamHash(baseSpec)).toBe(upstreamHash({ ...baseSpec }));
  });

  it("ignores env key insertion order", () => {
    const a = upstreamHash({
      ...baseSpec,
      resolvedEnv: { A: "1", B: "2", C: "3" },
    });
    const b = upstreamHash({
      ...baseSpec,
      resolvedEnv: { C: "3", B: "2", A: "1" },
    });
    expect(a).toBe(b);
  });

  it("preserves args order (positional)", () => {
    const a = upstreamHash({ ...baseSpec, args: ["--port", "1", "--host", "x"] });
    const b = upstreamHash({ ...baseSpec, args: ["--host", "x", "--port", "1"] });
    expect(a).not.toBe(b);
  });

  it("differs on different command", () => {
    expect(upstreamHash({ ...baseSpec, command: "node" })).not.toBe(
      upstreamHash({ ...baseSpec, command: "deno" }),
    );
  });

  it("differs on different cwd", () => {
    expect(upstreamHash({ ...baseSpec, cwd: "" })).not.toBe(
      upstreamHash({ ...baseSpec, cwd: "/srv" }),
    );
  });

  it("differs on different resolvedEnv values", () => {
    const a = upstreamHash({ ...baseSpec, resolvedEnv: { TOKEN: "abc" } });
    const b = upstreamHash({ ...baseSpec, resolvedEnv: { TOKEN: "xyz" } });
    expect(a).not.toBe(b);
  });

  it("ignores serverName (same spec under different names → same hash)", () => {
    expect(upstreamHash({ ...baseSpec, serverName: "linear" })).toBe(
      upstreamHash({ ...baseSpec, serverName: "github" }),
    );
  });

  it("returns a sha256 hex string", () => {
    expect(upstreamHash(baseSpec)).toMatch(/^[0-9a-f]{64}$/);
  });
});
