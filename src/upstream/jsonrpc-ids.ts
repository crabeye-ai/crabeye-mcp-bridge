import type { JSONRPCMessage } from "@modelcontextprotocol/client";

export type RequestId = string | number;

export function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

export function hasMethod(message: JSONRPCMessage): boolean {
  return typeof (message as { method?: unknown }).method === "string";
}

export function requestIdOf(message: JSONRPCMessage): RequestId | undefined {
  const id = (message as { id?: unknown }).id;
  return hasMethod(message) && isRequestId(id) ? id : undefined;
}

export function cancelledRequestId(message: JSONRPCMessage): RequestId | undefined {
  const m = message as { method?: unknown; params?: { requestId?: unknown } };
  if (m.method !== "notifications/cancelled") return undefined;
  return isRequestId(m.params?.requestId) ? m.params.requestId : undefined;
}
