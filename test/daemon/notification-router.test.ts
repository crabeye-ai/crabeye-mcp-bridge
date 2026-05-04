import { describe, it, expect } from "vitest";
import { NotificationRouter } from "../../src/daemon/notification-router.js";
import { SubscriptionTracker } from "../../src/daemon/subscription-tracker.js";

describe("NotificationRouter", () => {
  it("broadcasts list_changed methods to all attached sessions", () => {
    const router = new NotificationRouter();
    const tracker = new SubscriptionTracker();
    const sessions = ["A", "B", "C"];
    for (const m of ["notifications/tools/list_changed", "notifications/prompts/list_changed", "notifications/resources/list_changed"]) {
      const route = router.route({ jsonrpc: "2.0", method: m }, sessions, tracker);
      expect(new Set(route)).toEqual(new Set(sessions));
    }
  });

  it("routes resources/updated only to subscribers of the URI", () => {
    const router = new NotificationRouter();
    const tracker = new SubscriptionTracker();
    tracker.subscribe("A", "mem://foo");
    tracker.subscribe("B", "mem://bar");
    const route = router.route(
      { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "mem://foo" } },
      ["A", "B"],
      tracker,
    );
    expect(route).toEqual(["A"]);
  });

  it("broadcasts logging/message", () => {
    const router = new NotificationRouter();
    const tracker = new SubscriptionTracker();
    const route = router.route(
      { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } },
      ["A", "B"],
      tracker,
    );
    expect(new Set(route)).toEqual(new Set(["A", "B"]));
  });

  it("broadcasts unenumerated/vendor methods (default-broadcast)", () => {
    const router = new NotificationRouter();
    const tracker = new SubscriptionTracker();
    const route = router.route(
      { jsonrpc: "2.0", method: "notifications/x-vendor/foo" },
      ["A", "B"],
      tracker,
    );
    expect(new Set(route)).toEqual(new Set(["A", "B"]));
  });

  it("returns empty list for unknown URI subscribers (no fan-out)", () => {
    const router = new NotificationRouter();
    const tracker = new SubscriptionTracker();
    const route = router.route(
      { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "mem://nobody" } },
      ["A"],
      tracker,
    );
    expect(route).toEqual([]);
  });

  it("routes notifications/initialized to nobody (manager swallows it separately)", () => {
    const router = new NotificationRouter();
    const tracker = new SubscriptionTracker();
    const route = router.route(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      ["A", "B"],
      tracker,
    );
    expect(route).toEqual([]);
  });
});
