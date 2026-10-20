/**
 * Per-child subscription registry. Tracks which sessions hold subscriptions
 * for each resource URI on a single shared child. Used by the manager to
 * dedupe `resources/subscribe` / `resources/unsubscribe` traffic to the
 * child (only first/last subscriber forwards) and to fan `resources/updated`
 * out to the right subset of sessions.
 */
export class SubscriptionTracker {
  // URI -> set of sessionIds subscribed to it.
  private byUri = new Map<string, Set<string>>();
  // sessionId -> set of URIs that session is subscribed to (reverse index for cheap removeSession).
  private bySession = new Map<string, Set<string>>();

  /** Returns true iff this is the first session subscribing to the URI on this child. */
  subscribe(sessionId: string, uri: string): boolean {
    let urisForSession = this.bySession.get(sessionId);
    if (urisForSession === undefined) {
      urisForSession = new Set();
      this.bySession.set(sessionId, urisForSession);
    }
    if (urisForSession.has(uri)) return false; // session already subscribed; child already informed
    urisForSession.add(uri);

    let sessionsForUri = this.byUri.get(uri);
    if (sessionsForUri === undefined) {
      sessionsForUri = new Set();
      this.byUri.set(uri, sessionsForUri);
    }
    const wasEmpty = sessionsForUri.size === 0;
    sessionsForUri.add(sessionId);
    return wasEmpty;
  }

  /** Returns true iff this was the last subscriber for the URI (caller forwards `resources/unsubscribe` to child). */
  unsubscribe(sessionId: string, uri: string): boolean {
    const urisForSession = this.bySession.get(sessionId);
    if (urisForSession === undefined || !urisForSession.has(uri)) return false;
    urisForSession.delete(uri);
    if (urisForSession.size === 0) this.bySession.delete(sessionId);

    const sessionsForUri = this.byUri.get(uri);
    if (sessionsForUri === undefined) return false;
    sessionsForUri.delete(sessionId);
    if (sessionsForUri.size === 0) {
      this.byUri.delete(uri);
      return true;
    }
    return false;
  }

  /** Sessions currently subscribed to the URI. */
  subscribersFor(uri: string): string[] {
    const set = this.byUri.get(uri);
    return set === undefined ? [] : Array.from(set);
  }

  /** Drop all subscriptions held by the session. Returns URIs that lost their last subscriber. */
  removeSession(sessionId: string): string[] {
    const uris = this.bySession.get(sessionId);
    if (uris === undefined) return [];
    const dropped: string[] = [];
    for (const uri of uris) {
      const sessions = this.byUri.get(uri);
      if (sessions === undefined) continue;
      sessions.delete(sessionId);
      if (sessions.size === 0) {
        this.byUri.delete(uri);
        dropped.push(uri);
      }
    }
    this.bySession.delete(sessionId);
    return dropped;
  }

  /** Total count of unique URIs with at least one subscriber. */
  subscriptionCount(): number {
    return this.byUri.size;
  }
}
