import type { SubscriptionTracker } from "./subscription-tracker.js";

/**
 * Routes child→bridge notifications across attached sessions on a shared
 * child. Pure: caller hands in the current `sessions` list and a tracker;
 * router returns which sessions get a copy.
 *
 * Routing matrix (AIT-247):
 *   tools/prompts/resources list_changed -> broadcast all sessions
 *   resources/updated                    -> only subscribers of the URI
 *   logging/message                      -> broadcast
 *   notifications/initialized            -> empty (swallowed by manager)
 *   progress / cancelled                 -> NOT routed here; TokenRewriter handles them
 *   anything else (vendor, unknown)      -> broadcast (default-broadcast safe net)
 */
export class NotificationRouter {
  route(payload: unknown, sessions: string[], tracker: SubscriptionTracker): string[] {
    if (typeof payload !== "object" || payload === null) return [];
    const p = payload as { method?: unknown; params?: unknown };
    if (typeof p.method !== "string") return [];

    switch (p.method) {
      case "notifications/initialized":
        return [];
      case "notifications/tools/list_changed":
      case "notifications/prompts/list_changed":
      case "notifications/resources/list_changed":
      case "notifications/message":
        return [...sessions];
      case "notifications/resources/updated": {
        const params = p.params as { uri?: unknown } | undefined;
        if (params === undefined || typeof params.uri !== "string") return [];
        const subs = new Set(tracker.subscribersFor(params.uri));
        return sessions.filter((s) => subs.has(s));
      }
      default:
        // Default-broadcast for unknown / vendor methods. progress and cancelled
        // never reach this function — TokenRewriter handles them inbound.
        return [...sessions];
    }
  }
}
