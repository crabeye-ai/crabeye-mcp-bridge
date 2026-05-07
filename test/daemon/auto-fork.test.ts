import { describe, it, expect } from "vitest";
import { AutoForkOrchestrator } from "../../src/daemon/auto-fork.js";
import { createNoopLogger } from "../../src/logging/index.js";

describe("AutoForkOrchestrator — detection", () => {
  function freshOrchestrator(): AutoForkOrchestrator {
    return new AutoForkOrchestrator({ logger: createNoopLogger() });
  }

  it("isDangerousServerRequest returns true for requests with method+id (numeric)", () => {
    const orch = freshOrchestrator();
    expect(
      orch.isDangerousServerRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "sampling/createMessage",
        params: {},
      }),
    ).toBe(true);
  });

  it("isDangerousServerRequest returns true for requests with method+id (string)", () => {
    const orch = freshOrchestrator();
    expect(
      orch.isDangerousServerRequest({
        jsonrpc: "2.0",
        id: "abc",
        method: "roots/list",
      }),
    ).toBe(true);
  });

  it("isDangerousServerRequest returns false for notifications (no id)", () => {
    const orch = freshOrchestrator();
    expect(
      orch.isDangerousServerRequest({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      }),
    ).toBe(false);
  });

  it("isDangerousServerRequest returns false for responses (no method)", () => {
    const orch = freshOrchestrator();
    expect(
      orch.isDangerousServerRequest({ jsonrpc: "2.0", id: 1, result: {} }),
    ).toBe(false);
  });

  it("isDangerousServerRequest returns false for non-objects", () => {
    const orch = freshOrchestrator();
    expect(orch.isDangerousServerRequest(null)).toBe(false);
    expect(orch.isDangerousServerRequest("a string")).toBe(false);
    expect(orch.isDangerousServerRequest(42)).toBe(false);
    expect(orch.isDangerousServerRequest(undefined)).toBe(false);
  });
});
