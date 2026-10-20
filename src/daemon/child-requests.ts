import { APP_NAME } from "../constants.js";
import { methodLabel } from "../logging/index.js";

const METHOD_NOT_FOUND = -32601;

export interface ChildRequest {
  id: string | number;
  method: string;
}

export function isChildRequest(payload: unknown): payload is ChildRequest {
  if (typeof payload !== "object" || payload === null) return false;
  const { id, method } = payload as { id?: unknown; method?: unknown };
  return typeof method === "string" && (typeof id === "string" || typeof id === "number");
}

export function answerChildRequest({ id, method }: ChildRequest, label: string = methodLabel(method)): unknown {
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  return {
    jsonrpc: "2.0",
    id,
    error: { code: METHOD_NOT_FOUND, message: `${APP_NAME} doesn't support "${label}" requests from upstream servers` },
  };
}
