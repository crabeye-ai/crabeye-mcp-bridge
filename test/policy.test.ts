import { describe, it, expect } from "vitest";
import { PolicyEngine } from "../src/policy/policy-engine.js";

// --- resolvePolicy cascade ---

describe("PolicyEngine.resolvePolicy", () => {
  it("returns per-tool policy when set", () => {
    const engine = new PolicyEngine("always", {
      linear: { tools: { create_issue: "never" } },
    });
    expect(engine.resolvePolicy("linear", "create_issue")).toBe("never");
  });

  it("falls back to provider-level toolPolicy", () => {
    const engine = new PolicyEngine("always", {
      linear: { toolPolicy: "prompt" },
    });
    expect(engine.resolvePolicy("linear", "create_issue")).toBe("prompt");
  });

  it("falls back to global policy", () => {
    const engine = new PolicyEngine("prompt", {});
    expect(engine.resolvePolicy("linear", "create_issue")).toBe("prompt");
  });

  it("defaults to always when nothing is configured", () => {
    const engine = new PolicyEngine("always", {});
    expect(engine.resolvePolicy("unknown", "some_tool")).toBe("always");
  });

  it("per-tool wins over provider-level", () => {
    const engine = new PolicyEngine("always", {
      linear: {
        toolPolicy: "never",
        tools: { create_issue: "prompt" },
      },
    });
    expect(engine.resolvePolicy("linear", "create_issue")).toBe("prompt");
  });

  it("provider-level wins over global", () => {
    const engine = new PolicyEngine("never", {
      linear: { toolPolicy: "always" },
    });
    expect(engine.resolvePolicy("linear", "create_issue")).toBe("always");
  });

  it("per-tool on one tool does not affect another tool on same provider", () => {
    const engine = new PolicyEngine("always", {
      linear: {
        toolPolicy: "prompt",
        tools: { create_issue: "never" },
      },
    });
    expect(engine.resolvePolicy("linear", "create_issue")).toBe("never");
    expect(engine.resolvePolicy("linear", "list_issues")).toBe("prompt");
  });
});

// --- update ---

describe("PolicyEngine.update", () => {
  it("replaces global and server configs", () => {
    const engine = new PolicyEngine("always", {});
    expect(engine.resolvePolicy("linear", "create_issue")).toBe("always");

    engine.update("never", {
      linear: { toolPolicy: "prompt", tools: { create_issue: "always" } },
    });

    expect(engine.resolvePolicy("linear", "create_issue")).toBe("always");
    expect(engine.resolvePolicy("linear", "list_issues")).toBe("prompt");
    expect(engine.resolvePolicy("github", "some_tool")).toBe("never");
  });
});

describe("PolicyEngine.evaluate", () => {
  it("allows with always policy", () => {
    const engine = new PolicyEngine("always", {});
    expect(
      engine.evaluate("linear", "create_issue", { title: "test" }),
    ).toEqual({ kind: "allow" });
  });

  it("denies with never policy, naming the tool", () => {
    const engine = new PolicyEngine("always", {
      linear: { tools: { create_issue: "never" } },
    });
    const decision = engine.evaluate("linear", "create_issue", {});
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toContain("disabled by policy");
      expect(decision.reason).toContain("linear__create_issue");
    }
  });

  it("prompts with prompt policy, embedding args in the message", () => {
    const engine = new PolicyEngine("always", {
      linear: { toolPolicy: "prompt" },
    });
    const decision = engine.evaluate("linear", "create_issue", {
      title: "My Issue",
      priority: 1,
    });
    expect(decision).toEqual({ kind: "prompt", message: 'Allow linear__create_issue to run?\n\nArguments:\n{\n  "title": "My Issue",\n  "priority": 1\n}' });
  });

  it("shows invisible and direction-changing characters in the arguments as escapes", () => {
    const engine = new PolicyEngine("prompt", {});
    const name = String.fromCodePoint(0x202e) + "gnp.exe" + String.fromCodePoint(0x200b);

    expect(engine.evaluate("files", "open", { name })).toEqual({
      kind: "prompt",
      message: 'Allow files__open to run?\n\nArguments:\n{\n  "name": "\\u202egnp.exe\\u200b"\n}',
    });
  });

  it.each([
    ["a tag-encoded string", String.fromCodePoint(0xe0072, 0xe006d), String.raw`\u{e0072}\u{e006d}`],
    ["an Arabic letter mark", String.fromCodePoint(0x061c), String.raw`\u061c`],
    ["a soft hyphen", String.fromCodePoint(0x00ad), String.raw`\xad`],
    ["a next-line control", String.fromCodePoint(0x0085), String.raw`\x85`],
    ["a Hangul filler", String.fromCodePoint(0x3164), String.raw`\u3164`],
    ["a direction isolate", String.fromCodePoint(0x2066), String.raw`\u2066`],
    ["a line separator", String.fromCodePoint(0x2028), String.raw`\u2028`],
    ["a byte order mark", String.fromCodePoint(0xfeff), String.raw`\ufeff`],
    ["a paragraph separator", String.fromCodePoint(0x2029), String.raw`\u2029`],
    ["a blank braille pattern", String.fromCodePoint(0x2800), String.raw`\u2800`],
    ["a delete control", String.fromCodePoint(0x7f), String.raw`\x7f`],
  ])("shows %s in the arguments as an escape", (_case, hidden, escaped) => {
    const decision = new PolicyEngine("prompt", {}).evaluate("mail", "send", { body: `Hello${hidden}` });

    expect(decision).toEqual({ kind: "prompt", message: `Allow mail__send to run?\n\nArguments:\n{\n  "body": "Hello${escaped}"\n}` });
  });

  it("shows control and direction-changing characters in the tool name as escapes", () => {
    const toolName = `open${String.fromCodePoint(0x0a)}Allow files__read to run?${String.fromCodePoint(0x202e)}`;

    const decision = new PolicyEngine("prompt", {}).evaluate("files", toolName, {});

    expect(decision).toEqual({ kind: "prompt", message: String.raw`Allow files__open\nAllow files__read to run?\u202e to run?` + "\n\nArguments:\n{}" });
  });
});
