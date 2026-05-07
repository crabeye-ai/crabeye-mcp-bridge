import type { Logger } from "../logging/index.js";
import type { ChildGroup, SessionAttachment } from "./manager.js";

export interface AutoForkDeps {
  logger: Logger;
  /**
   * Send a payload to the group's child (writes to its stdin). Used to
   * deliver JSON-RPC error responses for `shared` mode and daemon-issued
   * initialize/subscribe replay against newly-spawned children.
   */
  sendToChild: (group: ChildGroup, payload: unknown) => void;
  /**
   * Forward a server→bridge payload to one specific session. Used for
   * `dedicated` mode and the originating-session triggering-request hand-off
   * during auto-fork.
   */
  sendToSession: (group: ChildGroup, sessionId: string, payload: unknown) => void;
  /**
   * Set of `${groupId}:${method}` keys that have already produced a warning
   * for shared-mode server→client requests. Shared by all groups owned by
   * the same manager so it survives across handleServerRequest calls.
   */
  warnedShared: Set<string>;
  /** Mark a hash auto-tainted; future auto OPENs spawn fresh dedicated. */
  taintAuto: (hash: string) => void;
  /** Remove a group from the manager's shareable index (used at fork start). */
  delistShareable: (group: ChildGroup, sharing: "auto" | "shared") => void;
  /**
   * Spawn a fresh dedicated child for a specific session. Uses that
   * session's openSpec verbatim. Returns null if spawn fails or the
   * session is unknown.
   */
  spawnDedicatedForSession: (forSessionId: string) => ChildGroup | null;
  /** Look up a SessionAttachment. */
  getAttachment: (sessionId: string) => SessionAttachment | undefined;
  /** Allocate a fresh internal-id for a group; returns the negative integer. */
  nextInternalId: (group: ChildGroup) => number;
  /** Register a pending internal-request callback. */
  registerInternal: (group: ChildGroup, id: number, cb: (payload: unknown) => void) => void;
  /** Unregister (e.g. on timeout). */
  unregisterInternal: (group: ChildGroup, id: number) => void;
  /** Force-kill a group (used when initialize replay fails). */
  killGroup: (group: ChildGroup) => void;
  /**
   * Evict a session: emit SESSION_EVICTED notification + force-detach.
   * Stub for Task 11 (just logs); Task 13 implements the real path.
   */
  evictSession: (
    sessionId: string,
    reason: "auto_fork_initialize_failed" | "auto_fork_drain_timeout",
  ) => void;
  /** URIs a session subscribed to within a specific group. */
  urisForSession: (group: ChildGroup, sessionId: string) => string[];
  /** Register a subscription on the new group's tracker after replay succeeds. */
  registerSubscription: (group: ChildGroup, sessionId: string, uri: string) => void;
  /** Attempt completion: if replay done AND old-group inflight is empty, finalize. */
  attemptCompleteMigration: (
    oldGroup: ChildGroup,
    newGroup: ChildGroup,
    sessionId: string,
  ) => void;
  /** Force-complete migration (used by drain timeout in Task 13; expose now for completion logic). */
  completeMigration: (
    oldGroup: ChildGroup,
    newGroup: ChildGroup,
    sessionId: string,
  ) => void;
  /** Synthesize INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT for any pending old-child
      inflight requests for this session. Caller must subsequently complete migration. */
  synthDrainTimeoutErrors: (oldGroup: ChildGroup, sessionId: string) => void;
  /** Initialize-replay timeout; from config. */
  autoForkInitializeTimeoutMs: number;
  /** Drain-window timeout; from config. */
  autoForkDrainTimeoutMs: number;
}

interface InitResult {
  protocolVersion: string;
  serverInfo: { name: string; version: string; [k: string]: unknown };
  capabilities: Record<string, unknown>;
}

/**
 * AutoForkOrchestrator owns auto-fork orchestration:
 *
 * - Detects server→client requests on shared children (which can't be
 *   fanned out to multiple sessions).
 * - Runs per-session migration to dedicated children with daemon-issued
 *   initialize/subscribe replay.
 * - Manages drain timeout and outbound buffering during migration.
 */
export class AutoForkOrchestrator {
  constructor(private readonly deps: AutoForkDeps) {}

  /**
   * Returns true if a child→bridge payload is a server→client REQUEST
   * (has both `method` and a string/numeric `id`). Notifications and
   * responses return false. Non-objects return false.
   *
   * Server→client requests can't be fan-out-routed across multiple
   * sessions on a shared child — each one needs a single client to
   * respond. In `auto` mode, every such request triggers a fork.
   */
  isServerRequest(payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null) return false;
    const p = payload as { id?: unknown; method?: unknown };
    return (
      typeof p.method === "string" &&
      (typeof p.id === "string" || typeof p.id === "number")
    );
  }

  /**
   * Handle a detected server→client request. Behavior depends on the
   * group's sharing config:
   *
   * - `shared`: synthesize -32601 to the child; warn once per (group, method).
   * - `dedicated`: forward to the single attached session's bridge.
   * - `auto`: fork — split the shared group into per-session dedicated
   *   children and migrate non-originating sessions.
   */
  async handleServerRequest(group: ChildGroup, payload: unknown): Promise<void> {
    const p = payload as { id?: string | number; method?: string };
    const method = p.method ?? "<unknown>";
    const id = p.id;

    if (group.sharing === "shared") {
      const warnKey = `${group.groupId}:${method}`;
      if (!this.deps.warnedShared.has(warnKey)) {
        this.deps.warnedShared.add(warnKey);
        this.deps.logger.warn(
          `auto-fork: shared upstream emitted server→client request "${method}"; replying -32601`,
          { component: "auto-fork", upstreamHash: group.upstreamHash, method },
        );
      }
      if (id !== undefined) {
        this.deps.sendToChild(group, {
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        });
      }
      return;
    }

    if (group.sharing === "dedicated") {
      const sole = Array.from(group.sessions)[0];
      if (sole === undefined) {
        this.deps.logger.warn(
          `auto-fork: dedicated group has no attached session, dropping request "${method}"`,
          { component: "auto-fork", upstreamHash: group.upstreamHash, method },
        );
        return;
      }
      this.deps.sendToSession(group, sole, payload);
      return;
    }

    // auto — fork.
    await this.fork(group, payload);
  }

  /**
   * Auto-fork: split a shared `auto` group into per-session dedicated children.
   * Originating session (first attached) keeps the old child as dedicated.
   * Non-originating sessions get fresh dedicated children with daemon-issued
   * initialize replay using their per-session caps.
   *
   * Subscribe replay, drain detection, and migration completion land in
   * Task 12. Drain timeout + eviction in Task 13.
   */
  private async fork(group: ChildGroup, triggeringPayload: unknown): Promise<void> {
    const sessionIds = Array.from(group.sessions);
    if (sessionIds.length === 0) {
      this.deps.logger.warn(
        `auto-fork: no sessions on group, dropping triggering request`,
        { component: "auto-fork", upstreamHash: group.upstreamHash },
      );
      return;
    }
    const originatingSessionId = sessionIds[0]!;
    this.deps.logger.info(
      `auto-fork: forking group "${group.upstreamHash}" (originating session "${originatingSessionId}")`,
      {
        component: "auto-fork",
        upstreamHash: group.upstreamHash,
        originatingSessionId,
      },
    );

    // Taint hash and de-list the group so further attaches don't land here.
    this.deps.taintAuto(group.upstreamHash);
    this.deps.delistShareable(group, "auto");

    // Flip mode and forked flag on the old group. NOTE: ChildGroup fields
    // are mutable (not readonly) by current convention — this works.
    group.mode = "dedicated";
    group.forked = true;

    // Forward triggering request to originating session's bridge BEFORE
    // awaiting migrations so the bridge can start working on the response
    // in parallel with the spawn/replay of the other children.
    this.deps.sendToSession(group, originatingSessionId, triggeringPayload);

    // Migrate non-originating sessions in parallel. allSettled so one
    // session's failure doesn't block the others.
    const migrations: Promise<void>[] = [];
    for (const sid of sessionIds) {
      if (sid === originatingSessionId) continue;
      migrations.push(this.migrateSession(group, sid));
    }
    await Promise.allSettled(migrations);
  }

  private async migrateSession(oldGroup: ChildGroup, sessionId: string): Promise<void> {
    const att = this.deps.getAttachment(sessionId);
    if (att === undefined) return;

    const newGroup = this.deps.spawnDedicatedForSession(sessionId);
    if (newGroup === null) {
      this.deps.evictSession(sessionId, "auto_fork_initialize_failed");
      return;
    }

    // Transition session to draining state. Subscribe replay + drain hook
    // + migration completion → Task 12. Drain timer arming → Task 13.
    att.migration = {
      kind: "draining",
      newGroup,
      queuedOutbound: [],
      drainDeadline: Date.now() + this.deps.autoForkDrainTimeoutMs,
      drainTimer: null,
      replayDone: false,
    };

    // Phase D (Task 13): arm the drain timer. `autoForkDrainTimeoutMs === 0`
    // disables the timer (test convenience — wait forever for drain).
    if (this.deps.autoForkDrainTimeoutMs > 0) {
      const drainTimer = setTimeout(() => {
        this.onDrainTimeout(oldGroup, newGroup, sessionId);
      }, this.deps.autoForkDrainTimeoutMs);
      if (typeof drainTimer.unref === "function") drainTimer.unref();
      att.migration.drainTimer = drainTimer;
    }

    // Daemon-issued initialize against new child.
    const init = await this.sendInternalRequest(
      newGroup,
      {
        method: "initialize",
        params: {
          protocolVersion: att.protocolVersion,
          clientInfo: att.clientInfo,
          capabilities: att.clientCapabilities,
        },
      },
      this.deps.autoForkInitializeTimeoutMs,
    );

    if (init === null || init.error !== undefined) {
      this.deps.killGroup(newGroup);
      this.deps.evictSession(sessionId, "auto_fork_initialize_failed");
      return;
    }

    // Cache init result on new child for any later short-circuit needs.
    if (init.result !== undefined && this.isInitResult(init.result)) {
      newGroup.child.setCachedInit({
        protocolVersion: init.result.protocolVersion,
        serverInfo: init.result.serverInfo,
        capabilities: init.result.capabilities,
      });
    }

    // Send initialized notification (no id, no response).
    this.deps.sendToChild(newGroup, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // Subscribe replay + drain hook + migration completion → Task 12.
    // Replay subscriptions sequentially.
    const uris = this.deps.urisForSession(oldGroup, sessionId);
    for (const uri of uris) {
      const sub = await this.sendInternalRequest(
        newGroup,
        {
          method: "resources/subscribe",
          params: { uri },
        },
        this.deps.autoForkInitializeTimeoutMs,
      );
      if (sub === null || sub.error !== undefined) {
        this.deps.logger.warn(`auto-fork: subscribe replay failed for "${uri}"`, {
          component: "auto-fork",
          upstreamHash: oldGroup.upstreamHash,
          sessionId,
          uri,
        });
        continue;
      }
      this.deps.registerSubscription(newGroup, sessionId, uri);
    }

    // Mark replay complete on the migration state.
    const post = this.deps.getAttachment(sessionId);
    if (post !== undefined && post.migration.kind === "draining") {
      post.migration.replayDone = true;
    }

    // Attempt completion: if old-child inflight is already zero, transition to migrated now.
    this.deps.attemptCompleteMigration(oldGroup, newGroup, sessionId);
  }

  /**
   * Hook called by the manager whenever a draining session's old-group inflight
   * count may have decreased (i.e. after every response delivery). Delegates to
   * the manager-side completion attempt.
   */
  onSessionInflightChanged(oldGroup: ChildGroup, newGroup: ChildGroup, sessionId: string): void {
    this.deps.attemptCompleteMigration(oldGroup, newGroup, sessionId);
  }

  /**
   * Phase D (Task 13): drain timer fired. Two cases:
   *
   * - `replayDone`: the new child is ready, but old-child inflight requests are
   *   stuck. Synthesize -32002 errors back to the bridge for each stuck inflight
   *   so the client can give up cleanly, then force-complete the migration —
   *   queued outbound flushes through the new child.
   * - `!replayDone`: the new child never finished daemon-issued initialize +
   *   subscribe replay. Kill the new child and evict the session entirely; the
   *   bridge can reconnect.
   */
  private onDrainTimeout(
    oldGroup: ChildGroup,
    newGroup: ChildGroup,
    sessionId: string,
  ): void {
    const att = this.deps.getAttachment(sessionId);
    if (att === undefined) return;
    if (att.migration.kind !== "draining") return;

    if (att.migration.replayDone) {
      // Replay done; force-complete by synthesizing -32002 for stuck inflight,
      // then transitioning to migrated.
      this.deps.synthDrainTimeoutErrors(oldGroup, sessionId);
      this.deps.completeMigration(oldGroup, newGroup, sessionId);
      return;
    }

    // Replay incomplete; evict.
    this.deps.killGroup(newGroup);
    this.deps.evictSession(sessionId, "auto_fork_drain_timeout");
  }

  /**
   * Send a request with a negative id to a child and await the response.
   * Returns null on timeout. Returns `{ result, error }` shape from the
   * response.
   */
  private async sendInternalRequest(
    group: ChildGroup,
    body: { method: string; params?: unknown },
    timeoutMs: number,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } } | null> {
    const id = this.deps.nextInternalId(group);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.deps.unregisterInternal(group, id);
        resolve(null);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      this.deps.registerInternal(group, id, (payload) => {
        clearTimeout(timer);
        const p = payload as {
          result?: unknown;
          error?: { code: number; message: string };
        };
        resolve({ result: p.result, error: p.error });
      });

      this.deps.sendToChild(group, {
        jsonrpc: "2.0",
        id,
        method: body.method,
        params: body.params,
      });
    });
  }

  private isInitResult(r: unknown): r is InitResult {
    if (typeof r !== "object" || r === null) return false;
    const x = r as {
      protocolVersion?: unknown;
      serverInfo?: unknown;
      capabilities?: unknown;
    };
    return (
      typeof x.protocolVersion === "string" &&
      typeof x.serverInfo === "object" &&
      x.serverInfo !== null &&
      typeof x.capabilities === "object" &&
      x.capabilities !== null
    );
  }
}
