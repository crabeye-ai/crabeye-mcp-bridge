import { describe, it, expect } from "vitest";
import { SubscriptionTracker } from "../../src/daemon/subscription-tracker.js";

describe("SubscriptionTracker", () => {
  it("first subscriber for a URI returns true; second returns false", () => {
    const t = new SubscriptionTracker();
    expect(t.subscribe("A", "mem://foo")).toBe(true);
    expect(t.subscribe("B", "mem://foo")).toBe(false);
  });

  it("subscribersFor returns all sessions with that URI", () => {
    const t = new SubscriptionTracker();
    t.subscribe("A", "mem://foo");
    t.subscribe("B", "mem://foo");
    t.subscribe("A", "mem://bar");
    expect(new Set(t.subscribersFor("mem://foo"))).toEqual(new Set(["A", "B"]));
    expect(t.subscribersFor("mem://bar")).toEqual(["A"]);
    expect(t.subscribersFor("mem://baz")).toEqual([]);
  });

  it("unsubscribe returns true only when last subscriber drops the URI", () => {
    const t = new SubscriptionTracker();
    t.subscribe("A", "mem://foo");
    t.subscribe("B", "mem://foo");
    expect(t.unsubscribe("A", "mem://foo")).toBe(false);
    expect(t.unsubscribe("B", "mem://foo")).toBe(true);
  });

  it("unsubscribe of an unheld URI returns false (no-op)", () => {
    const t = new SubscriptionTracker();
    expect(t.unsubscribe("A", "mem://foo")).toBe(false);
  });

  it("removeSession returns URIs that are now without subscribers", () => {
    const t = new SubscriptionTracker();
    t.subscribe("A", "mem://foo");
    t.subscribe("A", "mem://bar");
    t.subscribe("B", "mem://bar");
    const dropped = t.removeSession("A");
    expect(new Set(dropped)).toEqual(new Set(["mem://foo"]));
    expect(t.subscribersFor("mem://bar")).toEqual(["B"]);
  });

  it("subscriptionCount returns total unique URIs across sessions", () => {
    const t = new SubscriptionTracker();
    t.subscribe("A", "mem://foo");
    t.subscribe("B", "mem://foo");
    t.subscribe("A", "mem://bar");
    expect(t.subscriptionCount()).toBe(2);
  });
});
