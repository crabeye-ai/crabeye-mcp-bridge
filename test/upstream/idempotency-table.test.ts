import { describe, it, expect } from "vitest";
import { IdempotencyTable } from "../../src/upstream/idempotency-table.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

function req(id: number | string, method: string): JSONRPCMessage {
  return { jsonrpc: "2.0", id, method } as JSONRPCMessage;
}

describe("IdempotencyTable", () => {
  it("classifies known read-only MCP methods as retryable", () => {
    const t = new IdempotencyTable();
    t.track(req(1, "tools/list"));
    expect(t.snapshotForRetry().retryable).toHaveLength(1);
    expect(t.snapshotForRetry().evicted).toHaveLength(0);
  });

  it("classifies non-listed methods as not retryable", () => {
    const t = new IdempotencyTable();
    t.track(req(2, "tools/call"));
    const snap = t.snapshotForRetry();
    expect(snap.retryable).toHaveLength(0);
    expect(snap.evicted).toHaveLength(1);
  });

  it("forgets entries on response", () => {
    const t = new IdempotencyTable();
    t.track(req(3, "tools/list"));
    t.onResponse({ jsonrpc: "2.0", id: 3, result: {} } as JSONRPCMessage);
    expect(t.snapshotForRetry().retryable).toHaveLength(0);
  });

  it("returns the snapshot for retry, partitioning retryable vs evicted", () => {
    const t = new IdempotencyTable();
    t.track(req(1, "tools/list"));
    t.track(req(2, "tools/call"));
    const snap = t.snapshotForRetry();
    expect(snap.retryable).toHaveLength(1);
    expect((snap.retryable[0] as { method?: string }).method).toBe("tools/list");
    expect(snap.evicted).toHaveLength(1);
    expect((snap.evicted[0] as { id?: unknown }).id).toBe(2);
  });

  it("ignores messages that aren't requests (no method, or notification with no id)", () => {
    const t = new IdempotencyTable();
    t.track({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} } as JSONRPCMessage);
    t.track({ jsonrpc: "2.0", id: 5, result: {} } as JSONRPCMessage);
    expect(t.snapshotForRetry().retryable).toHaveLength(0);
    expect(t.snapshotForRetry().evicted).toHaveLength(0);
  });

  it("treats every retryable method literal as retryable", () => {
    const retryable = [
      "tools/list",
      "prompts/list",
      "prompts/get",
      "resources/list",
      "resources/read",
      "resources/templates/list",
    ];
    const t = new IdempotencyTable();
    let i = 0;
    for (const m of retryable) {
      i++;
      t.track(req(i, m));
    }
    expect(t.snapshotForRetry().retryable).toHaveLength(retryable.length);
    expect(t.snapshotForRetry().evicted).toHaveLength(0);
  });

  it("clear() empties the table", () => {
    const t = new IdempotencyTable();
    t.track(req(1, "tools/list"));
    expect(t.snapshotForRetry().retryable).toHaveLength(1);
    t.clear();
    expect(t.snapshotForRetry().retryable).toHaveLength(0);
  });
});
