import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const RETRYABLE_METHODS: ReadonlySet<string> = new Set([
  "tools/list",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/read",
  "resources/templates/list",
]);

/**
 * Tracks outbound MCP JSON-RPC requests on a single bridge→daemon transport.
 * Read-only methods (per `RETRYABLE_METHODS`) are silently re-issued after a
 * daemon respawn; everything else is evicted with a synthesized error. The
 * MCP client retains the pending Promise by id, so resent requests resolve
 * naturally when the response arrives.
 *
 * Duplicate ids overwrite the previous entry — the MCP client allocates ids,
 * and an id collision there would already be a client-side bug.
 */
export class IdempotencyTable {
  private byId = new Map<string | number, JSONRPCMessage>();

  track(message: JSONRPCMessage): void {
    if (!isRequest(message)) return;
    this.byId.set((message as { id: string | number }).id, message);
  }

  onResponse(message: JSONRPCMessage): void {
    const m = message as { id?: string | number };
    if (m.id === undefined) return;
    this.byId.delete(m.id);
  }

  /**
   * Snapshot for the respawn flow. Caller is responsible for calling
   * `clear()` after replay/eviction handling — this method does not mutate.
   */
  snapshotForRetry(): { retryable: JSONRPCMessage[]; evicted: JSONRPCMessage[] } {
    const retryable: JSONRPCMessage[] = [];
    const evicted: JSONRPCMessage[] = [];
    for (const m of this.byId.values()) {
      const method = (m as { method?: string }).method;
      const isRetryable = method !== undefined && RETRYABLE_METHODS.has(method);
      (isRetryable ? retryable : evicted).push(m);
    }
    return { retryable, evicted };
  }

  clear(): void {
    this.byId.clear();
  }
}

function isRequest(m: JSONRPCMessage): boolean {
  const o = m as { id?: unknown; method?: unknown };
  return (
    typeof o.method === "string" &&
    (typeof o.id === "string" || typeof o.id === "number")
  );
}
