import { describe, it, expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  renderPassthrough,
  TRUNCATION_MARKER,
} from "../../src/server/passthrough.js";
import type { PassthroughDeps } from "../../src/server/passthrough.js";
import type { ServerConfig, ToolPolicy } from "../../src/config/schema.js";

function tool(name: string, description: string, inputSchema?: unknown): Tool {
  return {
    name,
    description,
    inputSchema: (inputSchema ?? { type: "object" }) as Tool["inputSchema"],
  };
}

function makeDeps(overrides: {
  upstreams: Record<string, ServerConfig>;
  instructions?: Record<string, string>;
  tools?: Record<string, Tool[]>;
  policy?: Record<string, ToolPolicy>;
}): PassthroughDeps {
  return {
    upstreams: overrides.upstreams,
    getInstructions: (k) => overrides.instructions?.[k],
    getTools: (k) => overrides.tools?.[k] ?? [],
    resolvePolicy: (configKey, toolName) =>
      overrides.policy?.[`${configKey}__${toolName}`] ?? "always",
  };
}

const HTTP_BASE: Pick<
  Extract<ServerConfig, { type: string }>,
  "type" | "url"
> = { type: "streamable-http", url: "https://example.test/mcp" };

describe("renderPassthrough — AIT-183", () => {
  it("produces empty string when no upstream opts in", () => {
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          a: { ...HTTP_BASE },
          b: { ...HTTP_BASE, _bridge: {} },
          c: { ...HTTP_BASE, _bridge: { passthrough: false } },
        },
      }),
    );
    expect(out).toBe("");
  });

  it("level=instructions appends only the upstream's instructions text", () => {
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          linear: {
            ...HTTP_BASE,
            _bridge: { passthrough: "instructions" },
          },
        },
        instructions: { linear: "Use Linear for issue tracking." },
        tools: { linear: [tool("linear__create_issue", "Create issue")] },
      }),
    );
    expect(out).toBe("## linear\n\nUse Linear for issue tracking.");
    expect(out).not.toContain("### Tools");
  });

  it("level=instructions skips the entire block when upstream has no instructions", () => {
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          linear: {
            ...HTTP_BASE,
            _bridge: { passthrough: "instructions" },
          },
        },
        instructions: {},
      }),
    );
    expect(out).toBe("");
  });

  it("level=tools renders heading + tool names + descriptions, no inputSchema", () => {
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          linear: { ...HTTP_BASE, _bridge: { passthrough: "tools" } },
        },
        instructions: { linear: "Use Linear." },
        tools: {
          linear: [
            tool("linear__create_issue", "Create issue", {
              type: "object",
              properties: { title: { type: "string" } },
            }),
            tool("linear__list_issues", "List issues"),
          ],
        },
      }),
    );
    expect(out).toContain("## linear");
    expect(out).toContain("Use Linear.");
    expect(out).toContain("### Tools");
    expect(out).toContain("- linear__create_issue — Create issue");
    expect(out).toContain("- linear__list_issues — List issues");
    expect(out).not.toContain("inputSchema:");
  });

  it("level=full appends compact-JSON inputSchema after each tool", () => {
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          linear: { ...HTTP_BASE, _bridge: { passthrough: "full" } },
        },
        instructions: { linear: "Use Linear." },
        tools: {
          linear: [
            tool("linear__create_issue", "Create issue", {
              type: "object",
              properties: { title: { type: "string" } },
              required: ["title"],
            }),
          ],
        },
      }),
    );
    expect(out).toContain(
      `inputSchema: {"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}`,
    );
  });

  it("levels tools/full keep heading + tool list even when instructions are missing", () => {
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          linear: { ...HTTP_BASE, _bridge: { passthrough: "tools" } },
        },
        instructions: {},
        tools: {
          linear: [tool("linear__list_issues", "List issues")],
        },
      }),
    );
    expect(out).toContain("## linear");
    expect(out).toContain("### Tools");
    expect(out).toContain("- linear__list_issues — List issues");
  });

  it("excludes tools whose policy resolves to 'never'", () => {
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          linear: { ...HTTP_BASE, _bridge: { passthrough: "tools" } },
        },
        instructions: { linear: "x" },
        tools: {
          linear: [
            tool("linear__create_issue", "Create"),
            tool("linear__delete_issue", "Delete"),
          ],
        },
        policy: { linear__delete_issue: "never" },
      }),
    );
    expect(out).toContain("- linear__create_issue — Create");
    expect(out).not.toContain("- linear__delete_issue");
  });

  it("preserves upstream-declared tool order (no sort)", () => {
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          fs: { ...HTTP_BASE, _bridge: { passthrough: "tools" } },
        },
        instructions: { fs: "x" },
        tools: {
          fs: [
            tool("fs__zeta", "Z"),
            tool("fs__alpha", "A"),
            tool("fs__mu", "M"),
          ],
        },
      }),
    );
    const zeta = out.indexOf("fs__zeta");
    const alpha = out.indexOf("fs__alpha");
    const mu = out.indexOf("fs__mu");
    expect(zeta).toBeGreaterThan(0);
    expect(zeta).toBeLessThan(alpha);
    expect(alpha).toBeLessThan(mu);
  });

  it("uses the config key for the heading, not serverInfo.name", () => {
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          "my-custom-server": {
            ...HTTP_BASE,
            _bridge: { passthrough: "instructions" },
          },
        },
        instructions: { "my-custom-server": "hi" },
      }),
    );
    expect(out).toContain("## my-custom-server");
  });

  it("multiple servers concatenate in upstreams iteration order", () => {
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          aaa: { ...HTTP_BASE, _bridge: { passthrough: "instructions" } },
          zzz: { ...HTTP_BASE, _bridge: { passthrough: "instructions" } },
          mmm: { ...HTTP_BASE, _bridge: { passthrough: "instructions" } },
        },
        instructions: { aaa: "first", zzz: "second", mmm: "third" },
      }),
    );
    const a = out.indexOf("## aaa");
    const z = out.indexOf("## zzz");
    const m = out.indexOf("## mmm");
    expect(a).toBeLessThan(z);
    expect(z).toBeLessThan(m);
  });

  it("truncates at byte boundary and appends marker when over passthroughMaxBytes", () => {
    const long = "x".repeat(2_000);
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          big: {
            ...HTTP_BASE,
            _bridge: { passthrough: "instructions", passthroughMaxBytes: 64 },
          },
        },
        instructions: { big: long },
      }),
    );
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    const beforeMarker = out.slice(0, -TRUNCATION_MARKER.length);
    expect(Buffer.byteLength(beforeMarker, "utf-8")).toBeLessThanOrEqual(64);
  });

  it("does not truncate when rendered block already fits", () => {
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          small: {
            ...HTTP_BASE,
            _bridge: {
              passthrough: "instructions",
              passthroughMaxBytes: 1024,
            },
          },
        },
        instructions: { small: "tiny text" },
      }),
    );
    expect(out).not.toContain("(truncated)");
    expect(out).toBe("## small\n\ntiny text");
  });

  it("snaps truncation to a UTF-8 codepoint boundary", () => {
    // Each `é` is 2 bytes (0xC3 0xA9). Cap at an odd byte count and verify
    // we don't slice mid-codepoint (which would corrupt the string).
    const text = "é".repeat(50);
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          u: {
            ...HTTP_BASE,
            _bridge: { passthrough: "instructions", passthroughMaxBytes: 13 },
          },
        },
        instructions: { u: text },
      }),
    );
    const beforeMarker = out.slice(0, -TRUNCATION_MARKER.length);
    expect(beforeMarker).not.toContain("�");
  });

  it("snaps truncation cleanly across a 4-byte codepoint", () => {
    // U+1F600 GRINNING FACE = 4 bytes (0xF0 0x9F 0x98 0x80). Verify the
    // truncation never slices mid-emoji regardless of where the cap lands.
    const text = "AB" + "\u{1F600}".repeat(20);
    for (const cap of [3, 4, 5, 6, 7, 8, 9]) {
      const out = renderPassthrough(
        makeDeps({
          upstreams: {
            u: {
              ...HTTP_BASE,
              _bridge: {
                passthrough: "instructions",
                passthroughMaxBytes: cap,
              },
            },
          },
          instructions: { u: text },
        }),
      );
      // No replacement char => no mid-codepoint slice.
      expect(out).not.toContain("�");
    }
  });

  it("strips C0 controls, bidi overrides, and zero-width chars from upstream text", () => {
    // RLO + zero-width joiner + bidi isolate + BOM injected into instructions.
    const malicious =
      "Use ‮Linear‬ — see​⁦hidden⁩﻿.";
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          linear: { ...HTTP_BASE, _bridge: { passthrough: "instructions" } },
        },
        instructions: { linear: malicious },
      }),
    );
    expect(out).not.toMatch(/[‫-‮]/);
    expect(out).not.toMatch(/[​-‏]/);
    expect(out).not.toMatch(/[⁦-⁩]/);
    expect(out).not.toContain("﻿");
    // Visible ASCII content survives.
    expect(out).toContain("Use Linear");
  });

  it("renders BigInt-bearing inputSchema without throwing", () => {
    const tools: Record<string, Tool[]> = {
      linear: [
        {
          name: "linear__weird",
          description: "weird",
          // Cast through unknown — TS doesn't allow BigInt in `Tool` but a
          // hostile upstream's `passthrough()`-ed schema can carry one.
          inputSchema: {
            type: "object",
            properties: { n: { type: "number", default: BigInt(42) } },
          } as unknown as Tool["inputSchema"],
        },
      ],
    };
    expect(() =>
      renderPassthrough(
        makeDeps({
          upstreams: {
            linear: { ...HTTP_BASE, _bridge: { passthrough: "full" } },
          },
          instructions: { linear: "x" },
          tools,
        }),
      ),
    ).not.toThrow();
  });

  it("applies a built-in 256 KiB ceiling even without passthroughMaxBytes", () => {
    const huge = "x".repeat(2_000_000); // 2 MB
    const out = renderPassthrough(
      makeDeps({
        upstreams: {
          big: { ...HTTP_BASE, _bridge: { passthrough: "instructions" } },
        },
        instructions: { big: huge },
      }),
    );
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
    const beforeMarker = out.slice(0, -TRUNCATION_MARKER.length);
    expect(Buffer.byteLength(beforeMarker, "utf-8")).toBeLessThanOrEqual(
      256 * 1024,
    );
  });
});
