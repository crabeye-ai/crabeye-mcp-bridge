import { describe, it, expect } from "vitest";
import { InflightOverflowError, TokenRewriter } from "../../src/daemon/token-rewriter.js";

describe("TokenRewriter (phase C opaque-int)", () => {
  it("notification from child is kind=other with empty sessionIds and payload passed through", () => {
    // Phase C: routing of notifications (no id) is left to the caller — the
    // rewriter only resolves responses by outer id. Caller fans out to all
    // sessions attached to the child.
    const rw = new TokenRewriter();
    rw.attachSession("s1");
    const notif = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
    const out = rw.inboundFromChild(notif);
    expect(out.kind).toBe("other");
    expect(out.sessionIds).toEqual([]);
    expect(out.payload).toBe(notif);
  });

  it("returns no sessions when none are attached", () => {
    const rw = new TokenRewriter();
    const out = rw.inboundFromChild({ jsonrpc: "2.0", method: "x" });
    expect(out.sessionIds).toEqual([]);
  });

  it("tracks outbound request ids and clears them on inbound response", () => {
    const rw = new TokenRewriter();
    rw.attachSession("s1");
    const out1 = rw.outboundForChild({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }, "s1") as { id: number };
    const out2 = rw.outboundForChild({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} }, "s1") as { id: number };
    expect(rw.inflightForSession("s1").sort((a, b) => a - b)).toEqual([out1.id, out2.id].sort((a, b) => a - b));

    rw.inboundFromChild({ jsonrpc: "2.0", id: out1.id, result: {} });
    expect(rw.inflightForSession("s1")).toEqual([out2.id]);
  });

  it("ignores notifications without inner id (no inflight tracking)", () => {
    const rw = new TokenRewriter();
    rw.attachSession("s1");
    rw.outboundForChild({ jsonrpc: "2.0", method: "notifications/cancelled" }, "s1");
    expect(rw.inflightForSession("s1")).toEqual([]);
  });

  it("detachSession clears tracking", () => {
    const rw = new TokenRewriter();
    rw.attachSession("s1");
    rw.outboundForChild({ jsonrpc: "2.0", id: 99, method: "tools/call" }, "s1");
    rw.detachSession("s1");
    expect(rw.inflightForSession("s1")).toEqual([]);
    expect(rw.inboundFromChild({ jsonrpc: "2.0", id: 99, result: {} }).sessionIds).toEqual([]);
  });

  it("throws InflightOverflowError when per-session inflight cap is reached", () => {
    const rw = new TokenRewriter({ maxInflightPerSession: 3 });
    rw.attachSession("s1");
    rw.outboundForChild({ jsonrpc: "2.0", id: 1, method: "x" }, "s1");
    rw.outboundForChild({ jsonrpc: "2.0", id: 2, method: "x" }, "s1");
    rw.outboundForChild({ jsonrpc: "2.0", id: 3, method: "x" }, "s1");
    expect(() =>
      rw.outboundForChild({ jsonrpc: "2.0", id: 4, method: "x" }, "s1"),
    ).toThrow(InflightOverflowError);
    // The overflowed id is NOT in the tracking set (the throw fires before add).
    expect(rw.inflightForSession("s1")).toEqual([1, 2, 3]);
  });

  it("removeInflight pops a single id without delivering a response", () => {
    const rw = new TokenRewriter();
    rw.attachSession("s1");
    const out1 = rw.outboundForChild({ jsonrpc: "2.0", id: 1, method: "x" }, "s1") as { id: number };
    const out2 = rw.outboundForChild({ jsonrpc: "2.0", id: 2, method: "x" }, "s1") as { id: number };
    rw.removeInflight("s1", out1.id);
    expect(rw.inflightForSession("s1")).toEqual([out2.id]);
    // Idempotent — popping an id that isn't tracked does nothing.
    rw.removeInflight("s1", 999);
    expect(rw.inflightForSession("s1")).toEqual([out2.id]);
  });

  it("peekOrigin returns the original inner id for an allocated outer id, then detach clears mapping", () => {
    const rw = new TokenRewriter();
    rw.attachSession("s1");
    const out = rw.outboundForChild({ jsonrpc: "2.0", id: "req-abc", method: "x" }, "s1") as { id: number };
    const origin = rw.peekOrigin(out.id);
    expect(origin).toBeDefined();
    expect(origin!.originalId).toBe("req-abc");
    expect(origin!.sessionId).toBe("s1");

    const { cancelledOuterIds } = rw.detachSession("s1");
    expect(cancelledOuterIds).toEqual([out.id]);
    expect(rw.peekOrigin(out.id)).toBeUndefined();
  });

  it(
    "two separate rewriters (per-child) keep their inflight maps isolated " +
      "— guards the API contract for phase C cross-session collision rewriting",
    () => {
      const rwA = new TokenRewriter();
      const rwB = new TokenRewriter();
      rwA.attachSession("s1");
      rwB.attachSession("s2");

      // Same inner ids on different children.
      rwA.outboundForChild({ jsonrpc: "2.0", id: 1, method: "tools/call" }, "s1");
      rwB.outboundForChild({ jsonrpc: "2.0", id: 1, method: "tools/call" }, "s2");

      // Each rewriter routes only to its own session.
      expect(rwA.inboundFromChild({ jsonrpc: "2.0", id: 1, result: { ok: "A" } }).sessionIds).toEqual(["s1"]);
      expect(rwB.inboundFromChild({ jsonrpc: "2.0", id: 1, result: { ok: "B" } }).sessionIds).toEqual(["s2"]);

      // After response the inflight set is empty.
      expect(rwA.inflightForSession("s1")).toEqual([]);
      expect(rwB.inflightForSession("s2")).toEqual([]);
    },
  );
});
