import { describe, it, expect } from "vitest";
import { TokenRewriter } from "../../src/daemon/token-rewriter.js";

describe("TokenRewriter — opaque-int id rewriting", () => {
  it("two sessions sending id=1 get distinct outer ids", () => {
    const r = new TokenRewriter();
    r.attachSession("A");
    r.attachSession("B");

    const aOut = r.outboundForChild({ jsonrpc: "2.0", id: 1, method: "tools/call" }, "A") as { id: unknown };
    const bOut = r.outboundForChild({ jsonrpc: "2.0", id: 1, method: "tools/call" }, "B") as { id: unknown };

    expect(typeof aOut.id).toBe("number");
    expect(typeof bOut.id).toBe("number");
    expect(aOut.id).not.toBe(bOut.id);
  });

  it("inbound response restores original id and routes to originating session", () => {
    const r = new TokenRewriter();
    r.attachSession("A");
    r.attachSession("B");
    const aOut = r.outboundForChild({ jsonrpc: "2.0", id: 1, method: "tools/call" }, "A") as { id: number };
    const bOut = r.outboundForChild({ jsonrpc: "2.0", id: 1, method: "tools/call" }, "B") as { id: number };

    const aResp = r.inboundFromChild({ jsonrpc: "2.0", id: aOut.id, result: { ok: "A" } });
    const bResp = r.inboundFromChild({ jsonrpc: "2.0", id: bOut.id, result: { ok: "B" } });

    expect(aResp.kind).toBe("response");
    expect(aResp.sessionIds).toEqual(["A"]);
    expect((aResp.payload as { id: unknown }).id).toBe(1);
    expect(bResp.sessionIds).toEqual(["B"]);
    expect((bResp.payload as { id: unknown }).id).toBe(1);
  });

  it("string original id round-trips correctly", () => {
    const r = new TokenRewriter();
    r.attachSession("A");
    const out = r.outboundForChild({ jsonrpc: "2.0", id: "req-abc", method: "ping" }, "A") as { id: number };
    const back = r.inboundFromChild({ jsonrpc: "2.0", id: out.id, result: { ok: true } });
    expect((back.payload as { id: unknown }).id).toBe("req-abc");
  });

  it("response with unknown outer id is dropped (sessionIds empty)", () => {
    const r = new TokenRewriter();
    r.attachSession("A");
    const back = r.inboundFromChild({ jsonrpc: "2.0", id: 99999, result: {} });
    expect(back.sessionIds).toEqual([]);
    expect(back.kind).toBe("drop");
  });
});

describe("TokenRewriter — progressToken", () => {
  it("rewrites outbound progressToken and routes inbound progress to origin", () => {
    const r = new TokenRewriter();
    r.attachSession("A");
    r.attachSession("B");
    const aReq = r.outboundForChild(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: { progressToken: "tok-A" } } },
      "A",
    ) as { params: { _meta: { progressToken: unknown } } };
    const bReq = r.outboundForChild(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { _meta: { progressToken: "tok-B" } } },
      "B",
    ) as { params: { _meta: { progressToken: unknown } } };

    expect(typeof aReq.params._meta.progressToken).toBe("number");
    expect(aReq.params._meta.progressToken).not.toBe(bReq.params._meta.progressToken);

    const aProg = r.inboundFromChild({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: aReq.params._meta.progressToken, progress: 50, total: 100 },
    });
    expect(aProg.kind).toBe("progress");
    expect(aProg.sessionIds).toEqual(["A"]);
    expect((aProg.payload as { params: { progressToken: unknown } }).params.progressToken).toBe("tok-A");
  });

  it("inbound progress with unknown token is dropped", () => {
    const r = new TokenRewriter();
    r.attachSession("A");
    const back = r.inboundFromChild({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: 99999, progress: 1 },
    });
    expect(back.kind).toBe("drop");
    expect(back.sessionIds).toEqual([]);
  });
});

describe("TokenRewriter — cancelled.requestId", () => {
  it("rewrites outbound cancelled.requestId to the outer id of the cancelled request", () => {
    const r = new TokenRewriter();
    r.attachSession("A");
    const aReq = r.outboundForChild({ jsonrpc: "2.0", id: 7, method: "tools/call" }, "A") as { id: number };
    const cancel = r.outboundForChild(
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "user" } },
      "A",
    ) as { params: { requestId: unknown } };
    expect(cancel.params.requestId).toBe(aReq.id);
  });

  it("drops outbound cancelled.requestId for an unknown id (defensive — id never sent)", () => {
    const r = new TokenRewriter();
    r.attachSession("A");
    const cancel = r.outboundForChild(
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 999, reason: "user" } },
      "A",
    );
    expect(cancel).toBeNull();
  });
});
