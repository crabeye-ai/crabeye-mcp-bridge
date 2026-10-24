import type { InnerId } from "./token-rewriter.js";

export type ChildEraLabel = "modern" | "legacy" | "unknown";

export interface ChildEraOptions {
  answerModernFromStore: boolean;
}

const DISCOVER_METHOD = "server/discover";
const INITIALIZE_METHOD = "initialize";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const UNSUPPORTED_PROTOCOL_VERSION = -32022;
const LEGACY_REFUSAL = { error: { code: -32601, message: "Method not found" } };
const MAX_STORED_REPLY_CHARS = 256 * 1024;

type StoredReply = { result: Record<string, unknown> } | { error: unknown };

export type DiscoverReply = { jsonrpc: "2.0"; id: InnerId } & StoredReply;

interface Verdict {
  label: "modern" | "legacy";
  reply: StoredReply;
  inferred: boolean;
}

interface Message {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export class ChildEra {
  private verdict: Verdict | null = null;
  private candidate: Record<string, unknown> | null = null;
  private readonly pendingProbes = new Map<number, string>();
  private readonly overtakenProbes = new Map<number, string | null>();
  private readonly forwardedInitializes = new Set<number>();

  constructor(private readonly options: ChildEraOptions) {}

  get label(): ChildEraLabel {
    return this.verdict?.label ?? "unknown";
  }

  answerFor(payload: unknown): DiscoverReply | null {
    const id = discoverRequestId(payload);
    if (id === null || this.verdict === null) return null;
    if (this.verdict.label === "modern" && !this.options.answerModernFromStore) return null;
    return { jsonrpc: "2.0", id, ...this.verdict.reply };
  }

  noteForwarded(sessionId: string, payload: unknown, outerId: number): void {
    if (discoverRequestId(payload) !== null) this.pendingProbes.set(outerId, sessionId);
    else if (asMessage(payload)?.method === INITIALIZE_METHOD) this.forwardedInitializes.add(outerId);
  }

  isProbe(outerId: number): boolean {
    return this.pendingProbes.has(outerId) || this.overtakenProbes.has(outerId);
  }

  noteWritten(payload: unknown): void {
    const message = asMessage(payload);
    if (message === null || typeof message.method !== "string" || this.verdict?.label === "modern") return;
    const claimedVersion = claimedModernVersion(message);
    if (claimedVersion !== null) {
      if (message.method !== DISCOVER_METHOD && message.id !== undefined) this.confirmModern(claimedVersion);
      return;
    }
    this.candidate = null;
    for (const [outerId, owner] of this.pendingProbes) this.overtakenProbes.set(outerId, owner);
    this.pendingProbes.clear();
  }

  noteChildResponse(payload: unknown): void {
    const reply = asMessage(payload);
    if (reply === null || typeof reply.id !== "number" || reply.method !== undefined) return;
    if (this.forwardedInitializes.delete(reply.id)) {
      if (errorCode(reply.error) === UNSUPPORTED_PROTOCOL_VERSION && this.verdict?.label === "legacy") this.verdict = null;
      return;
    }
    const trusted = this.pendingProbes.delete(reply.id);
    const overtaken = this.overtakenProbes.delete(reply.id);
    if (!trusted && !overtaken) return;
    if (isStorableDiscoverResult(reply.result)) {
      if (trusted) this.candidate ??= reply.result;
      else if (this.verdict?.inferred) this.verdict = null;
      return;
    }
    if (isStorableRefusal(reply.error) && (this.verdict === null || this.verdict.inferred)) {
      this.settle({ label: "legacy", reply: { error: reply.error }, inferred: false });
    }
  }

  noteInitialize(sessionId: string): number[] {
    const ownProbes = [
      ...this.probesOf(this.pendingProbes, sessionId),
      ...this.probesOf(this.overtakenProbes, sessionId),
    ];
    for (const outerId of ownProbes) {
      this.pendingProbes.delete(outerId);
      this.overtakenProbes.set(outerId, null);
    }
    if (ownProbes.length > 0) this.verdict ??= { label: "legacy", reply: LEGACY_REFUSAL, inferred: true };
    return ownProbes;
  }

  forgetSession(sessionId: string): void {
    for (const outerId of this.probesOf(this.pendingProbes, sessionId)) this.pendingProbes.delete(outerId);
    for (const outerId of this.probesOf(this.overtakenProbes, sessionId)) this.overtakenProbes.set(outerId, null);
  }

  private confirmModern(claimedVersion: string): void {
    const candidate = this.candidate;
    if (candidate === null || this.verdict !== null) return;
    if (!(candidate.supportedVersions as string[]).includes(claimedVersion)) return;
    this.settle({ label: "modern", reply: { result: candidate }, inferred: false });
  }

  private settle(verdict: Verdict): void {
    this.verdict = verdict;
    this.candidate = null;
    this.overtakenProbes.clear();
  }

  private probesOf(probes: Map<number, string | null>, sessionId: string): number[] {
    return [...probes].filter(([, owner]) => owner === sessionId).map(([outerId]) => outerId);
  }
}

function asMessage(payload: unknown): Message | null {
  return isPlainObject(payload) ? (payload as Message) : null;
}

function discoverRequestId(payload: unknown): InnerId | null {
  const request = asMessage(payload);
  if (request === null || request.method !== DISCOVER_METHOD) return null;
  return typeof request.id === "string" || typeof request.id === "number" ? request.id : null;
}

function claimedModernVersion(message: Message): string | null {
  const meta = isPlainObject(message.params) ? message.params._meta : undefined;
  const version = isPlainObject(meta) ? meta[PROTOCOL_VERSION_META_KEY] : undefined;
  return typeof version === "string" ? version : null;
}

function errorCode(error: unknown): unknown {
  return isPlainObject(error) ? error.code : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStorableDiscoverResult(result: unknown): result is Record<string, unknown> {
  if (!isPlainObject(result) || !isPlainObject(result.capabilities)) return false;
  const versions = result.supportedVersions;
  return Array.isArray(versions) && versions.every((version) => typeof version === "string") && fitsStore(result);
}

function isStorableRefusal(error: unknown): boolean {
  return error !== undefined && errorCode(error) !== UNSUPPORTED_PROTOCOL_VERSION && fitsStore(error);
}

function fitsStore(value: unknown): boolean {
  return JSON.stringify(value).length <= MAX_STORED_REPLY_CHARS;
}
