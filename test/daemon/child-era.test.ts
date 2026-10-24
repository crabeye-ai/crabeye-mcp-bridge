import { describe, it, expect } from "vitest";
import { PROTOCOL_VERSION_META_KEY, ProtocolErrorCode } from "@modelcontextprotocol/client";
import { ChildEra } from "../../src/daemon/child-era.js";

const DISCOVER_RESULT = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } };
const LEGACY_REFUSAL = { code: ProtocolErrorCode.MethodNotFound, message: "Method not found" };
const MODERN_META = { [PROTOCOL_VERSION_META_KEY]: "2026-07-28" };
const discover = (id: string | number) => ({ jsonrpc: "2.0", id, method: "server/discover", params: { _meta: MODERN_META } });
const modernRequest = (id: number) => ({ jsonrpc: "2.0", id, method: "subscriptions/listen", params: { _meta: MODERN_META } });
const initialize = (id: number) => ({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-11-25" } });
const result = (id: number, value: unknown) => ({ jsonrpc: "2.0", id, result: value });
const failure = (id: number, code: number) => ({ jsonrpc: "2.0", id, error: { code, message: "nope" } });

function newEra(answerModernFromStore = true): ChildEra {
  return new ChildEra({ answerModernFromStore });
}

function forward(era: ChildEra, sessionId: string, payload: unknown, outerId: number): void {
  era.noteForwarded(sessionId, payload, outerId);
  era.noteWritten(payload);
}

function confirmedModern(answerModernFromStore = true): ChildEra {
  const era = newEra(answerModernFromStore);
  forward(era, "s1", discover("p-1"), 1);
  era.noteChildResponse(result(1, DISCOVER_RESULT));
  forward(era, "s1", modernRequest(2), 2);
  return era;
}

describe("ChildEra", () => {
  it("starts unknown and answers no probes", () => {
    const era = newEra();

    expect(era.label).toBe("unknown");
    expect(era.answerFor(discover("p-1"))).toBeNull();
  });

  it("holds a discover result until the next request written to the child claims the modern era", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 1);
    era.noteChildResponse(result(1, DISCOVER_RESULT));

    expect(era.label).toBe("unknown");
    expect(era.answerFor(discover("p-2"))).toBeNull();

    forward(era, "s1", modernRequest(2), 2);

    expect(era.label).toBe("modern");
    expect(era.answerFor(discover("server-discover-probe-1"))).toEqual({
      jsonrpc: "2.0",
      id: "server-discover-probe-1",
      result: DISCOVER_RESULT,
    });
    expect(era.answerFor(discover(42))).toEqual({ jsonrpc: "2.0", id: 42, result: DISCOVER_RESULT });
  });

  it("isn't confirmed modern by a notification that claims the modern era, nor by a claimed request with no discover result", () => {
    const era = newEra();
    era.noteWritten(modernRequest(1));
    forward(era, "s1", discover("p-1"), 2);
    era.noteChildResponse(result(2, DISCOVER_RESULT));

    era.noteWritten({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9, _meta: MODERN_META } });

    expect(era.label).toBe("unknown");
  });

  it.each([
    ["a legacy initialize", initialize(5)],
    ["the daemon's own ping", { jsonrpc: "2.0", id: -1, method: "ping" }],
    ["a cancellation without an era claim", { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }],
    ["notifications/initialized", { jsonrpc: "2.0", method: "notifications/initialized" }],
    ["a resources/subscribe the daemon sends itself", { jsonrpc: "2.0", id: 6, method: "resources/subscribe", params: { uri: "file:///x" } }],
  ])("drops the discover result when %s reaches the child before any modern request", (_case, payload) => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 1);
    era.noteChildResponse(result(1, DISCOVER_RESULT));

    era.noteWritten(payload);
    forward(era, "s1", modernRequest(2), 2);

    expect(era.label).toBe("unknown");
    expect(era.answerFor(discover("p-2"))).toBeNull();
  });

  it("stays modern when unclaimed messages reach the child after a modern request", () => {
    const era = confirmedModern();

    era.noteWritten({ jsonrpc: "2.0", id: -1, method: "ping" });
    era.noteWritten(initialize(9));

    expect(era.label).toBe("modern");
  });

  it("doesn't trust a discover result for a probe that an unclaimed message overtook", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 1);
    era.noteWritten(initialize(2));

    era.noteChildResponse(result(1, DISCOVER_RESULT));
    forward(era, "s1", modernRequest(3), 3);

    expect(era.label).toBe("unknown");
  });

  it("forwards a modern child's probes when it may not answer them from the store", () => {
    const era = confirmedModern(false);

    expect(era.label).toBe("modern");
    expect(era.answerFor(discover(7))).toBeNull();
  });

  it("marks a child that refuses the probe as legacy and replays its error", () => {
    const era = newEra(false);
    forward(era, "s1", discover("p-1"), 1);
    era.noteChildResponse(failure(1, ProtocolErrorCode.MethodNotFound));

    expect(era.label).toBe("legacy");
    expect(era.answerFor(discover(9))).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: ProtocolErrorCode.MethodNotFound, message: "nope" },
    });
  });

  it.each([
    ["an unsupported-protocol-version error", failure(1, ProtocolErrorCode.UnsupportedProtocolVersion)],
    ["a result without supportedVersions", result(1, { capabilities: {} })],
    ["a result without capabilities", result(1, { supportedVersions: ["2026-07-28"] })],
    ["a result whose supportedVersions are not all strings", result(1, { supportedVersions: ["2026-07-28", 1], capabilities: {} })],
    ["an array result", result(1, ["2026-07-28"])],
    ["a result too large to keep", result(1, { ...DISCOVER_RESULT, instructions: "x".repeat(300 * 1024) })],
    ["an error too large to keep", { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "x".repeat(300 * 1024) } }],
  ])("stays unknown after %s", (_case, reply) => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 1);
    era.noteChildResponse(reply);
    forward(era, "s1", modernRequest(2), 2);

    expect(era.label).toBe("unknown");
    expect(era.answerFor(discover(3))).toBeNull();
  });

  it("ignores replies to requests that were not probes, and a child request that reuses a probe's id", () => {
    const era = newEra();
    forward(era, "s1", { jsonrpc: "2.0", id: 9, method: "tools/list", params: { _meta: MODERN_META } }, 1);
    forward(era, "s1", discover("p-1"), 2);

    era.noteChildResponse(result(1, DISCOVER_RESULT));
    era.noteChildResponse({ jsonrpc: "2.0", id: 2, method: "roots/list", params: {} });
    era.noteChildResponse(result(2, DISCOVER_RESULT));
    forward(era, "s1", modernRequest(3), 3);

    expect(era.label).toBe("modern");
  });

  it("keeps the first verdict the child itself gave when several probes were forwarded before it", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 1);
    forward(era, "s2", discover("p-1"), 2);

    era.noteChildResponse(failure(1, ProtocolErrorCode.MethodNotFound));
    era.noteChildResponse(result(2, DISCOVER_RESULT));
    forward(era, "s2", modernRequest(3), 3);

    expect(era.label).toBe("legacy");
  });

  it("infers legacy when a session sends initialize while its probe is unanswered, and returns that probe once", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 5);

    expect(era.noteInitialize("s1")).toEqual([5]);
    expect(era.noteInitialize("s1")).toEqual([]);
    expect(era.label).toBe("legacy");
    expect(era.answerFor(discover("p-2"))).toEqual({ jsonrpc: "2.0", id: "p-2", error: LEGACY_REFUSAL });
  });

  it("returns a session's probe that another session's initialize already overtook when that session initializes too", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 5);
    forward(era, "s2", discover("p-1"), 6);
    expect(era.noteInitialize("s1")).toEqual([5]);
    era.noteWritten(initialize(7));

    expect(era.noteInitialize("s2")).toEqual([6]);
    expect(era.label).toBe("legacy");
  });

  it("infers legacy for a probing session even after a session that never probed sent its initialize first", () => {
    const era = newEra();
    forward(era, "current", discover("p-1"), 5);
    expect(era.noteInitialize("released-bridge")).toEqual([]);
    era.noteWritten(initialize(6));

    expect(era.noteInitialize("current")).toEqual([5]);
    expect(era.label).toBe("legacy");
  });

  it("doesn't let an initialize answered without reaching the child overtake other probes", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 5);
    era.noteInitialize("released-bridge");

    era.noteChildResponse(result(5, DISCOVER_RESULT));
    forward(era, "s1", modernRequest(6), 6);

    expect(era.label).toBe("modern");
  });

  it.each([
    ["a late discover result for the abandoned probe", result(5, DISCOVER_RESULT)],
    ["the child refusing the forwarded initialize as an unsupported protocol version", failure(7, ProtocolErrorCode.UnsupportedProtocolVersion)],
  ])("asks the child again after %s instead of keeping the inferred legacy verdict", (_case, reply) => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 5);
    era.noteInitialize("s1");
    forward(era, "s1", initialize(7), 7);

    era.noteChildResponse(reply);

    expect(era.label).toBe("unknown");
    expect(era.answerFor(discover("p-3"))).toBeNull();
  });

  it("asks the child again when it refuses a forwarded initialize after an error it gave settled the era as legacy", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 5);
    era.noteChildResponse(failure(5, ProtocolErrorCode.InternalError));
    expect(era.label).toBe("legacy");
    forward(era, "s1", initialize(7), 7);

    era.noteChildResponse(failure(7, ProtocolErrorCode.UnsupportedProtocolVersion));

    expect(era.label).toBe("unknown");
    expect(era.answerFor(discover("p-2"))).toBeNull();
  });

  it("isn't confirmed modern by a request claiming a version the child didn't list", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 1);
    era.noteChildResponse(result(1, DISCOVER_RESULT));

    forward(era, "s1", { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: { [PROTOCOL_VERSION_META_KEY]: "2099-01-01" } } }, 2);

    expect(era.label).toBe("unknown");
  });

  it("treats a discover request without an era claim like any other unclaimed message", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 1);
    era.noteWritten({ jsonrpc: "2.0", id: 2, method: "server/discover", params: {} });

    era.noteChildResponse(result(1, DISCOVER_RESULT));
    forward(era, "s1", modernRequest(3), 3);

    expect(era.label).toBe("unknown");
  });

  it("knows which forwarded requests are probes, pending or overtaken", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 1);
    forward(era, "s1", { jsonrpc: "2.0", id: 9, method: "tools/call", params: {} }, 2);
    forward(era, "s2", discover("p-1"), 3);

    expect([1, 2, 3].map((outerId) => era.isProbe(outerId))).toEqual([true, false, true]);
    era.noteChildResponse(result(3, DISCOVER_RESULT));
    expect(era.isProbe(3)).toBe(false);
  });

  it("forgets overtaken probes once the child settles its era", () => {
    const era = newEra();
    forward(era, "s1", discover(1), 1);
    forward(era, "s1", initialize(2), 2);
    forward(era, "s2", discover(3), 3);

    era.noteChildResponse(failure(3, ProtocolErrorCode.MethodNotFound));
    expect(era.isProbe(1)).toBe(false);

    forward(era, "s3", initialize(4), 4);
    era.noteChildResponse(failure(4, ProtocolErrorCode.UnsupportedProtocolVersion));
    era.noteChildResponse(failure(1, ProtocolErrorCode.MethodNotFound));
    expect(era.label).toBe("unknown");
  });

  it("keeps the inferred legacy verdict when the child accepts the forwarded initialize", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 5);
    era.noteInitialize("s1");
    forward(era, "s1", initialize(7), 7);

    era.noteChildResponse(result(7, { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "x", version: "1" } }));

    expect(era.answerFor(discover(1))).toEqual({ jsonrpc: "2.0", id: 1, error: LEGACY_REFUSAL });
  });

  it.each([
    ["refuses", failure(8, ProtocolErrorCode.MethodNotFound), "legacy"],
    ["answers", result(8, DISCOVER_RESULT), "modern"],
  ])("settles the era from the next probe after a reset when the child %s it", (_case, reply, label) => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 5);
    era.noteInitialize("s1");
    era.noteChildResponse(result(5, DISCOVER_RESULT));

    forward(era, "s2", discover("p-1"), 8);
    era.noteChildResponse(reply);
    forward(era, "s2", modernRequest(9), 9);

    expect(era.label).toBe(label);
  });

  it("settles an inferred legacy verdict with the child's own refusal of the abandoned probe", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 5);
    era.noteInitialize("s1");

    era.noteChildResponse(failure(5, ProtocolErrorCode.MethodNotFound));

    expect(era.answerFor(discover(1))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: ProtocolErrorCode.MethodNotFound, message: "nope" },
    });
  });

  it("leaves the era unknown when a session sends initialize without probing", () => {
    const era = newEra();

    expect(era.noteInitialize("old-bridge")).toEqual([]);
    expect(era.label).toBe("unknown");
  });

  it("forgets a detached session's pending probes but still lets an overtaken one undo an inferred verdict", () => {
    const era = newEra();
    forward(era, "s1", discover("p-1"), 1);
    era.forgetSession("s1");
    era.noteChildResponse(result(1, DISCOVER_RESULT));
    expect(era.noteInitialize("s1")).toEqual([]);

    forward(era, "s2", discover("p-1"), 2);
    forward(era, "s3", discover("p-1"), 3);
    era.noteInitialize("s2");
    era.noteWritten(initialize(4));
    era.forgetSession("s3");
    expect(era.label).toBe("legacy");

    era.noteChildResponse(result(3, DISCOVER_RESULT));

    expect(era.label).toBe("unknown");
  });

  it.each([
    [{ jsonrpc: "2.0", method: "server/discover" }],
    [{ jsonrpc: "2.0", id: 1, method: "tools/list" }],
    [null],
  ])("answers nothing for a payload that isn't a discover request (%j)", (payload) => {
    const era = confirmedModern();

    expect(era.answerFor(payload)).toBeNull();
  });
});
