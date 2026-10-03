import type { JSONRPCMessage } from "@modelcontextprotocol/client";
import { cancelledRequestId, isRequestId, requestIdOf, type RequestId } from "./jsonrpc-ids.js";

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
 * naturally when the response arrives. Sending a cancellation forgets the
 * request it cancels, so it is never re-issued.
 *
 * Duplicate ids overwrite the previous entry — the MCP client allocates ids,
 * and an id collision there would already be a client-side bug.
 */
export class IdempotencyTable {
  private byId = new Map<RequestId, JSONRPCMessage>();

  track(message: JSONRPCMessage): void {
    const cancelled = cancelledRequestId(message);
    if (cancelled !== undefined) this.forget(cancelled);
    const id = requestIdOf(message);
    if (id !== undefined) this.byId.set(id, message);
  }

  forget(id: RequestId): void {
    this.byId.delete(id);
  }

  onResponse(message: JSONRPCMessage): void {
    const id = (message as { id?: unknown }).id;
    if (isRequestId(id)) this.byId.delete(id);
  }

  /**
   * Snapshot for the respawn flow. Caller clears the table before re-sending,
   * since every re-sent request is tracked again.
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
