import type { Logger } from "../logging/index.js";

export interface AutoForkDeps {
  logger: Logger;
}

/**
 * AutoForkOrchestrator owns auto-fork orchestration:
 *
 * - Detects dangerous server→client requests on shared children.
 * - Runs per-session migration to dedicated children with daemon-issued
 *   initialize/subscribe replay.
 * - Manages drain timeout and outbound buffering during migration.
 *
 * Phase D scaffolding — fork mechanics are added in subsequent tasks
 * (9: shared/dedicated dispatch, 10: per-session state, 11: spawn + replay,
 * 12: drain detection + completion, 13: timeouts + SESSION_EVICTED).
 */
export class AutoForkOrchestrator {
  constructor(private readonly deps: AutoForkDeps) {}

  /**
   * Returns true if a child→bridge payload is a server→client REQUEST
   * (has both `method` and a string/numeric `id`). Notifications and
   * responses return false. Non-objects return false.
   *
   * In `auto` mode, every server→client request is treated as dangerous —
   * there is no per-method safe-set (that exists only for notifications,
   * handled by NotificationRouter).
   */
  isDangerousServerRequest(payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null) return false;
    const p = payload as { id?: unknown; method?: unknown };
    return (
      typeof p.method === "string" &&
      (typeof p.id === "string" || typeof p.id === "number")
    );
  }
}
