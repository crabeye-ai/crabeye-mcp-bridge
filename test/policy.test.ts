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
    expect(decision.kind).toBe("prompt");
    if (decision.kind === "prompt") {
      expect(decision.request.message).toContain('"title": "My Issue"');
      expect(decision.request.requestedSchema).toEqual({
        type: "object",
        properties: {},
      });
    }
  });

  it("handles undefined args gracefully", () => {
    const engine = new PolicyEngine("always", {
      linear: { toolPolicy: "prompt" },
    });
    const decision = engine.evaluate("linear", "create_issue", undefined);
    expect(decision.kind).toBe("prompt");
    if (decision.kind === "prompt") {
      expect(decision.request.message).toContain("{}");
    }
  });
});
