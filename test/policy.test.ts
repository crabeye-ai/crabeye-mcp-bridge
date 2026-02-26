import { describe, it, expect, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { PolicyEngine } from "../src/policy/policy-engine.js";
import type { ElicitFn } from "../src/policy/policy-engine.js";

const noopElicit: ElicitFn = vi.fn().mockResolvedValue({ action: "accept" });

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

// --- enforce ---

describe("PolicyEngine.enforce", () => {
  it("passes through with always policy", async () => {
    const engine = new PolicyEngine("always", {});
    await expect(
      engine.enforce("linear", "create_issue", { title: "test" }, noopElicit),
    ).resolves.toBeUndefined();
  });

  it("throws McpError with never policy", async () => {
    const engine = new PolicyEngine("always", {
      linear: { tools: { create_issue: "never" } },
    });
    await expect(
      engine.enforce("linear", "create_issue", {}, noopElicit),
    ).rejects.toThrow(McpError);

    try {
      await engine.enforce("linear", "create_issue", {}, noopElicit);
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidRequest);
      expect((err as McpError).message).toContain("disabled by policy");
      expect((err as McpError).message).toContain("linear__create_issue");
    }
  });

  it("passes with prompt policy when user accepts", async () => {
    const engine = new PolicyEngine("always", {
      linear: { toolPolicy: "prompt" },
    });
    const elicitFn: ElicitFn = vi.fn().mockResolvedValue({ action: "accept" });

    await expect(
      engine.enforce("linear", "create_issue", { title: "test" }, elicitFn),
    ).resolves.toBeUndefined();
    expect(elicitFn).toHaveBeenCalledOnce();
  });

  it("throws with prompt policy when user declines", async () => {
    const engine = new PolicyEngine("always", {
      linear: { toolPolicy: "prompt" },
    });
    const elicitFn: ElicitFn = vi.fn().mockResolvedValue({ action: "decline" });

    await expect(
      engine.enforce("linear", "create_issue", {}, elicitFn),
    ).rejects.toThrow(McpError);

    try {
      await engine.enforce("linear", "create_issue", {}, elicitFn);
    } catch (err) {
      expect((err as McpError).message).toContain("declined by user");
    }
  });

  it("throws with prompt policy when user cancels", async () => {
    const engine = new PolicyEngine("always", {
      linear: { toolPolicy: "prompt" },
    });
    const elicitFn: ElicitFn = vi.fn().mockResolvedValue({ action: "cancel" });

    await expect(
      engine.enforce("linear", "create_issue", {}, elicitFn),
    ).rejects.toThrow(McpError);
  });

  it("throws when elicitation is not supported by client", async () => {
    const engine = new PolicyEngine("always", {
      linear: { toolPolicy: "prompt" },
    });
    const elicitFn: ElicitFn = vi.fn().mockRejectedValue(
      new Error("Client does not support form elicitation."),
    );

    await expect(
      engine.enforce("linear", "create_issue", {}, elicitFn),
    ).rejects.toThrow(McpError);

    try {
      await engine.enforce("linear", "create_issue", {}, elicitFn);
    } catch (err) {
      expect((err as McpError).code).toBe(ErrorCode.InvalidRequest);
      expect((err as McpError).message).toContain("does not support elicitation");
    }
  });

  it("passes args in the elicitation message", async () => {
    const engine = new PolicyEngine("always", {
      linear: { toolPolicy: "prompt" },
    });
    const elicitFn: ElicitFn = vi.fn().mockResolvedValue({ action: "accept" });
    const args = { title: "My Issue", priority: 1 };

    await engine.enforce("linear", "create_issue", args, elicitFn);

    expect(elicitFn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('"title": "My Issue"'),
        requestedSchema: { type: "object", properties: {} },
      }),
    );
  });

  it("handles undefined args gracefully", async () => {
    const engine = new PolicyEngine("always", {
      linear: { toolPolicy: "prompt" },
    });
    const elicitFn: ElicitFn = vi.fn().mockResolvedValue({ action: "accept" });

    await engine.enforce("linear", "create_issue", undefined, elicitFn);

    expect(elicitFn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("{}"),
      }),
    );
  });
});
