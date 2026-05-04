/**
 * Per-child JSON-RPC token rewriter.
 *
 * Phase B: one session per child, so id rewriting is the identity. The
 * scaffold still:
 *
 * - Tracks which inner request `id`s a session has in flight, so the
 *   manager can emit synthetic `session_closed` errors for them when the
 *   session goes away.
 * - Routes inbound child→bridge messages to attached sessions.
 * - Caps inflight ids per session so a hostile bridge can't grow the
 *   tracking Set unboundedly with cheap RPC frames.
 *
 * Phase C swaps in real rewriting (collision-safe `id`, `progressToken`,
 * `cancelled.requestId` translation per session) without changing this
 * file's public surface.
 */

export type InnerId = string | number;

/**
 * Hard cap on tracked in-flight inner request ids per session. Each entry is
 * ~30 bytes; without this cap a malicious bridge can grow daemon RSS
 * unboundedly by sending unique-id RPC frames whose payloads are dropped
 * before the child ever responds.
 */
export const MAX_INFLIGHT_PER_SESSION = 4096;

export class InflightOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InflightOverflowError";
  }
}

export interface InboundRouting {
  /** Session(s) to deliver this payload to. Empty when no session is attached. */
  sessionIds: string[];
  payload: unknown;
}

export class TokenRewriter {
  private sessions = new Set<string>();
  private inflightBySession = new Map<string, Set<InnerId>>();
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

  detachSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.inflightBySession.delete(sessionId);
  }

  /**
   * Bridge → child rewrite. Phase B identity. Tracks the inner request id
   * (if any) so the inbound response can clear it and so close-cleanup can
   * surface synthetic errors for still-open requests. Throws
   * `InflightOverflowError` when the per-session cap is reached.
   */
  outboundForChild(payload: unknown, sessionId: string): unknown {
    const id = innerRequestId(payload);
    if (id !== null) {
      const set = this.inflightBySession.get(sessionId);
      if (set !== undefined) {
        if (set.size >= this.maxInflight) {
          throw new InflightOverflowError(
            `session ${sessionId} has ${set.size} in-flight requests (cap ${this.maxInflight})`,
          );
        }
        set.add(id);
      }
    }
    return payload;
  }

  /**
   * Pop a single in-flight id without delivering a response. Used when a
   * bridge→child write fails (backpressure) and we never expect the child
   * to answer this id, so we mustn't leak it in the tracking Set.
   */
  removeInflight(sessionId: string, id: InnerId): void {
    this.inflightBySession.get(sessionId)?.delete(id);
  }

  /**
   * Child → bridge route. Phase B: single session per child, deliver to it.
   * Clears in-flight tracking when the inbound payload is a response.
   */
  inboundFromChild(payload: unknown): InboundRouting {
    const responseId = innerResponseId(payload);
    if (responseId !== null) {
      for (const sid of this.sessions) {
        this.inflightBySession.get(sid)?.delete(responseId);
      }
    }
    return { sessionIds: Array.from(this.sessions), payload };
  }

  /**
   * Inner request ids the session has in flight, in insertion order. Used by
   * the manager to emit synthetic `session_closed` JSON-RPC error responses.
   */
  inflightForSession(sessionId: string): InnerId[] {
    const set = this.inflightBySession.get(sessionId);
    return set ? Array.from(set) : [];
  }
}

function innerRequestId(payload: unknown): InnerId | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { id?: unknown; method?: unknown };
  if (typeof p.method !== "string") return null;
  if (typeof p.id === "string" || typeof p.id === "number") return p.id;
  return null;
}

function innerResponseId(payload: unknown): InnerId | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
  if (typeof p.method === "string") return null;
  if (p.result === undefined && p.error === undefined) return null;
  if (typeof p.id === "string" || typeof p.id === "number") return p.id;
  return null;
}
