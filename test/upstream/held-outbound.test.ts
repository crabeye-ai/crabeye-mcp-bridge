import { describe, expect, it } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import { HeldOutbound } from "../../src/upstream/held-outbound.js";
import { cancelledRequestId, requestIdOf } from "../../src/upstream/jsonrpc-ids.js";

const request = (id: number, method = "tools/call"): JSONRPCMessage =>
  ({ jsonrpc: "2.0", id, method, params: {} }) as JSONRPCMessage;
const notification = (method: string, params?: unknown): JSONRPCMessage =>
  ({ jsonrpc: "2.0", method, ...(params !== undefined && { params }) }) as JSONRPCMessage;

describe("HeldOutbound", () => {
  it("drains held messages in the order they were held, then is empty", () => {
    const held = new HeldOutbound();
    const messages = [request(1), notification("notifications/progress"), request(2)];
    for (const m of messages) held.hold(m);

    expect(held.drain()).toEqual(messages);
    expect(held.drain()).toEqual([]);
  });

  it("removes a held request when it is cancelled", () => {
    const held = new HeldOutbound();
    held.hold(request(1));
    held.hold(request(2));

    expect(held.cancel(1)).toBe(true);
    expect(held.drain()).toEqual([request(2)]);
  });

  it("reports a cancellation for a request it does not hold", () => {
    const held = new HeldOutbound();
    held.hold(request(2));

    expect(held.cancel(1)).toBe(false);
    expect(held.drain()).toEqual([request(2)]);
  });

  it("does not hold responses, which answer a child that no longer exists", () => {
    const held = new HeldOutbound();
    held.hold({ jsonrpc: "2.0", id: 5, result: {} } as JSONRPCMessage);
    held.hold({ jsonrpc: "2.0", id: 6, error: { code: -1, message: "x" } } as JSONRPCMessage);

    expect(held.drain()).toEqual([]);
  });
});

describe("jsonrpc ids", () => {
  it("identifies request ids only on messages that carry a method", () => {
    expect(requestIdOf(request(3))).toBe(3);
    expect(requestIdOf({ jsonrpc: "2.0", id: 3, result: {} } as JSONRPCMessage)).toBeUndefined();
    expect(requestIdOf(notification("notifications/initialized"))).toBeUndefined();
  });

  it("reads the target of a cancellation", () => {
    expect(cancelledRequestId(notification("notifications/cancelled", { requestId: 4 }))).toBe(4);
    expect(cancelledRequestId(notification("notifications/progress", { requestId: 4 }))).toBeUndefined();
  });
});
