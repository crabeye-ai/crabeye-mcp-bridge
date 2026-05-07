/**
 * Per-child JSON-RPC token rewriter.
 *
 * Phase C: opaque-integer rewriting. Each bridge→child request gets a fresh
 * integer id allocated by the daemon. The original (sessionId, originalId)
 * is stored; the inbound response is reverse-mapped and the original id is
 * restored on the payload. Same scheme for `progressToken` and
 * `notifications/cancelled.requestId`.
 *
 * String tokens lose type fidelity (acceptable per AIT-247 scope).
 */

export type InnerId = string | number;

/** Hard cap on tracked in-flight outer ids per session. */
export const MAX_INFLIGHT_PER_SESSION = 4096;

export class InflightOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InflightOverflowError";
  }
}

export type InboundKind = "response" | "progress" | "cancelled" | "other" | "drop" | "internal";

export interface InboundRouting {
  /** Session(s) to deliver this payload to. Empty for "drop"; "other" leaves routing to caller. */
  sessionIds: string[];
  /** Payload with any outer tokens restored to originals. */
  payload: unknown;
  kind: InboundKind;
}

export interface OriginEntry {
  sessionId: string;
  originalId: InnerId;
}

interface ProgressOriginEntry {
  sessionId: string;
  originalToken: InnerId;
}

export class TokenRewriter {
  private sessions = new Set<string>();
  private nextOuterId = 1;
  private outerIdToOrigin = new Map<number, OriginEntry>();
  private inflightBySession = new Map<string, Set<number>>();
  private nextOuterProgress = 1;
  private outerProgressToOrigin = new Map<number, ProgressOriginEntry>();
  private readonly maxInflight: number;

  constructor(opts: { maxInflightPerSession?: number } = {}) {
    this.maxInflight = opts.maxInflightPerSession ?? MAX_INFLIGHT_PER_SESSION;
  }

  attachSession(sessionId: string): void {
    this.sessions.add(sessionId);
    if (!this.inflightBySession.has(sessionId)) {
      this.inflightBySession.set(sessionId, new Set());
    }
  }

  /**
   * Detach a session. Returns the outer ids that were in flight so the
   * caller can emit `notifications/cancelled` to the child before they are
   * dropped from the tracker.
   */
  detachSession(sessionId: string): { cancelledOuterIds: number[] } {
    const inflight = this.inflightBySession.get(sessionId) ?? new Set<number>();
    const cancelledOuterIds = Array.from(inflight);
    for (const outer of cancelledOuterIds) {
      this.outerIdToOrigin.delete(outer);
    }
    // Drop progress mappings owned by this session.
    for (const [outer, entry] of this.outerProgressToOrigin) {
      if (entry.sessionId === sessionId) this.outerProgressToOrigin.delete(outer);
    }
    this.inflightBySession.delete(sessionId);
    this.sessions.delete(sessionId);
    return { cancelledOuterIds };
  }

  /** Bridge → child rewrite. Allocates a fresh outer id for requests; passes notifications through (subject to per-method rules in later tasks). */
  outboundForChild(payload: unknown, sessionId: string): unknown | null {
    if (!isJsonObject(payload)) return payload;
    const p = payload as Record<string, unknown>;

    // notifications/cancelled rewrite: look up the outer id by (sessionId, originalId).
    if (typeof p.method === "string" && p.method === "notifications/cancelled") {
      const params = isJsonObject(p.params) ? (p.params as Record<string, unknown>) : undefined;
      const reqId = params?.requestId;
      if (typeof reqId !== "string" && typeof reqId !== "number") return null;
      let outerId: number | undefined;
      for (const [outer, origin] of this.outerIdToOrigin) {
        if (origin.sessionId === sessionId && origin.originalId === reqId) {
          outerId = outer;
          break;
        }
      }
      if (outerId === undefined) return null;
      return { ...p, params: { ...(params ?? {}), requestId: outerId } };
    }

    const isReq = typeof p.method === "string" && (typeof p.id === "string" || typeof p.id === "number");
    if (!isReq) return payload;
    const set = this.inflightBySession.get(sessionId);
    // Session not attached (e.g. detached mid-flight). Pass through; the response
    // will land as kind: "drop" since no outer id was allocated.
    if (set === undefined) return payload;
    if (set.size >= this.maxInflight) {
      throw new InflightOverflowError(
        `session ${sessionId} has ${set.size} in-flight requests (cap ${this.maxInflight})`,
      );
    }
    const outerId = this.nextOuterId++;
    this.outerIdToOrigin.set(outerId, { sessionId, originalId: p.id as InnerId });
    set.add(outerId);

    const rewritten: Record<string, unknown> = { ...p, id: outerId };
    const params = isJsonObject(p.params) ? (p.params as Record<string, unknown>) : undefined;
    if (params !== undefined) {
      const meta = isJsonObject(params._meta) ? (params._meta as Record<string, unknown>) : undefined;
      if (
        meta !== undefined &&
        (typeof meta.progressToken === "string" || typeof meta.progressToken === "number")
      ) {
        const outerProg = this.nextOuterProgress++;
        this.outerProgressToOrigin.set(outerProg, {
          sessionId,
          originalToken: meta.progressToken as InnerId,
        });
        rewritten.params = { ...params, _meta: { ...meta, progressToken: outerProg } };
      }
    }
    return rewritten;
  }

  /** Pop a single outer id without delivering a response. Used when a bridge→child write fails (backpressure). */
  removeInflight(sessionId: string, outerId: number): void {
    this.inflightBySession.get(sessionId)?.delete(outerId);
    this.outerIdToOrigin.delete(outerId);
  }

  /** Child → bridge route. Restores ids; returns routing decision. */
  inboundFromChild(payload: unknown): InboundRouting {
    if (!isJsonObject(payload)) return { sessionIds: [], payload, kind: "other" };
    const p = payload as Record<string, unknown>;
    // Phase D: daemon-issued internal requests use negative ids.
    // These never collide with the positive outerIds allocated for session→child traffic.
    if (
      typeof p.method !== "string" &&
      (p.result !== undefined || p.error !== undefined) &&
      typeof p.id === "number" &&
      p.id < 0
    ) {
      return { sessionIds: [], payload, kind: "internal" };
    }
    // Response: id present, no method, has result or error.
    if (
      typeof p.method !== "string" &&
      (p.result !== undefined || p.error !== undefined) &&
      typeof p.id === "number"
    ) {
      const origin = this.outerIdToOrigin.get(p.id as number);
      if (origin === undefined) return { sessionIds: [], payload, kind: "drop" };
      this.outerIdToOrigin.delete(p.id as number);
      this.inflightBySession.get(origin.sessionId)?.delete(p.id as number);
      return {
        sessionIds: [origin.sessionId],
        payload: { ...p, id: origin.originalId },
        kind: "response",
      };
    }
    if (typeof p.method === "string" && p.method === "notifications/progress") {
      const params = isJsonObject(p.params) ? (p.params as Record<string, unknown>) : undefined;
      const tok = params?.progressToken;
      if (typeof tok === "number") {
        const origin = this.outerProgressToOrigin.get(tok);
        if (origin === undefined) return { sessionIds: [], payload, kind: "drop" };
        // progressToken survives across multiple progress notifications, do NOT delete on each update.
        const restoredParams = { ...(params ?? {}), progressToken: origin.originalToken };
        return {
          sessionIds: [origin.sessionId],
          payload: { ...p, params: restoredParams },
          kind: "progress",
        };
      }
    }
    return { sessionIds: [], payload, kind: "other" };
  }

  /** Inner request ids the session has in flight (in insertion order). */
  inflightForSession(sessionId: string): number[] {
    const set = this.inflightBySession.get(sessionId);
    return set ? Array.from(set) : [];
  }

  /** Resolve an outer id back to its origin without consuming the mapping. */
  peekOrigin(outerId: number): OriginEntry | undefined {
    return this.outerIdToOrigin.get(outerId);
  }
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
