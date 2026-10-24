import { PROTOCOL_VERSION_META_KEY, SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/client";
import type { ChildHandle } from "../../src/daemon/child-handle.js";

export type DiscoverBehaviour = "modern" | "refuses" | "ignores" | "unsupported-version" | "sdk-serve" | "sdk-reject";

export const DISCOVER_RESULT = { supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, _meta: { serverInfo: { name: "child" } } };
export const INITIALIZE_RESULT = { protocolVersion: "2025-11-25", serverInfo: { name: "child", version: "1" }, capabilities: {} };
export const METHOD_NOT_FOUND = { code: -32601, message: "Method not found" };
export const LEGACY_REJECTED = { code: -32022, message: "legacy rejected" };
export const MODERN_META = { [PROTOCOL_VERSION_META_KEY]: "2026-07-28" };

interface Message {
  id?: number;
  method?: string;
  params?: { _meta?: Record<string, unknown> };
}

export interface ScriptedChild {
  received: Message[];
  answerLateProbe(): Promise<void>;
  announceToolListChange(): void;
  release(): void;
}

export function scriptedChild(behaviour: DiscoverBehaviour, slowStart: boolean, cb: { onMessage: (payload: unknown) => void }) {
  const received: Message[] = [];
  const held: Message[] = [];
  let started = !slowStart;
  let pinned: "modern" | "legacy" | null = null;
  let ignoredProbe: number | undefined;
  const listens: number[] = [];
  const emit = (payload: unknown, delayMs = 1) =>
    new Promise<void>((resolve) => setTimeout(() => { cb.onMessage(payload); resolve(); }, delayMs));
  const reply = (id: number | undefined, body: Record<string, unknown>, delayMs = 1) => emit({ jsonrpc: "2.0", id, ...body }, delayMs);
  const notify = (method: string, subscriptionId: number) =>
    emit({ jsonrpc: "2.0", method, params: { _meta: { [SUBSCRIPTION_ID_META_KEY]: subscriptionId } } });

  const probeAnswerDelayMs = behaviour === "sdk-reject" ? 3 : 1;
  const serveLikeSdk = (message: Message): void => {
    const claimed = typeof message.params?._meta?.[PROTOCOL_VERSION_META_KEY] === "string";
    if (message.method === undefined) return;
    if (message.id === undefined) {
      if (!claimed && pinned === null && behaviour === "sdk-serve") pinned = "legacy";
      return;
    }
    if (message.method === "server/discover" && pinned !== "legacy") {
      void reply(message.id, { result: DISCOVER_RESULT }, probeAnswerDelayMs);
      return;
    }
    if (pinned === null) {
      if (claimed) pinned = "modern";
      else if (behaviour === "sdk-reject") {
        void reply(message.id, { error: LEGACY_REJECTED });
        return;
      } else pinned = "legacy";
    }
    if (pinned === "legacy") {
      const unsupported = message.method === "server/discover" || message.method === "subscriptions/listen";
      const result = message.method === "initialize" ? INITIALIZE_RESULT : {};
      void reply(message.id, unsupported ? { error: METHOD_NOT_FOUND } : { result });
      return;
    }
    void reply(message.id, message.method === "initialize" && !claimed ? { error: LEGACY_REJECTED } : { result: {} });
  };

  const serveScripted = (message: Message): void => {
    if (message.method === "server/discover") {
      if (behaviour === "modern") void reply(message.id, { result: DISCOVER_RESULT });
      if (behaviour === "refuses") void reply(message.id, { error: METHOD_NOT_FOUND });
      if (behaviour === "unsupported-version") {
        void reply(message.id, { error: { code: -32022, message: "unsupported", data: { supported: ["2025-11-25"] } } });
      }
      if (behaviour === "ignores") ignoredProbe = message.id;
    } else if (message.method === "subscriptions/listen") {
      listens.push(message.id!);
      void notify("notifications/subscriptions/acknowledged", message.id!);
    } else if (message.method === "initialize") {
      void reply(message.id, { result: INITIALIZE_RESULT });
    } else if (message.method !== undefined && message.id !== undefined) {
      void reply(message.id, { result: {} });
    }
  };

  const serve = behaviour === "sdk-serve" || behaviour === "sdk-reject" ? serveLikeSdk : serveScripted;
  const handle = {
    startedAt: Date.now(),
    pid: 90_000,
    alive: true,
    cachedInit: null as unknown,
    setCachedInit(init: unknown) { handle.cachedInit = init; },
    send(payload: unknown) {
      const message = payload as Message;
      received.push(message);
      if (started) serve(message);
      else held.push(message);
    },
    async kill() { handle.alive = false; },
  };
  const child: ScriptedChild = {
    received,
    answerLateProbe: () => reply(ignoredProbe, { result: DISCOVER_RESULT }),
    announceToolListChange: () => listens.forEach((id) => void notify("notifications/tools/list_changed", id)),
    release: () => {
      started = true;
      for (const message of held.splice(0)) serve(message);
    },
  };
  return { handle: handle as unknown as ChildHandle, child };
}
