import { open, lstat, mkdir, chmod, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createNoopLogger, type Logger } from "../logging/index.js";
import { upstreamHash } from "../upstream/upstream-hash.js";
import { acquireLock, LockBusyError, type LockHandle } from "./lockfile.js";
import { ChildHandle, BackpressureError } from "./child-handle.js";
import type { CachedInit } from "./child-handle.js";
import { getProcessTrackerPath } from "./paths.js";
import { ProcessTracker } from "./process-tracker.js";
import {
  ERROR_CODE_INVALID_PARAMS,
  ERROR_CODE_INVALID_REQUEST,
  ERROR_CODE_SESSION_NOT_FOUND,
  ERROR_CODE_SPAWN_FAILED,
  ERROR_CODE_TOO_MANY_CONNECTIONS,
  ERROR_CODE_TOO_MANY_SESSIONS,
  ERROR_CODE_UNKNOWN_METHOD,
  INNER_ERROR_CODE_UPSTREAM_RESTARTED,
  INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE,
  INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT,
  INNER_ERROR_CODE_BACKPRESSURE,
  INNER_ERROR_CODE_SESSION_CLOSED,
  PROTOCOL_VERSION,
  isNotification,
  isRequest,
  type CloseParams,
  type DaemonError,
  type DaemonNotification,
  type DaemonRequest,
  type DaemonResponse,
  type OpenParams,
  type PingParams,
  type PingResult,
  type RestartParams,
  type RestartResult,
  type RpcNotificationParams,
  type SessionEvictedParams,
  type StatusChild,
  type StatusResult,
  type StatusSession,
  type UpstreamRestartedReason,
} from "./protocol.js";
import { InflightOverflowError, TokenRewriter, type InnerId } from "./token-rewriter.js";
import { SubscriptionTracker } from "./subscription-tracker.js";
import { NotificationRouter } from "./notification-router.js";
import { AutoForkOrchestrator } from "./auto-fork.js";
import { Telemetry, type KilledReason } from "./telemetry.js";
import type { DaemonServer, FrameChannel, Transport } from "./transport.js";

const isWindows = process.platform === "win32";

/** Bound on simultaneous IPC clients. Same-UID DoS hardening. */
const DEFAULT_MAX_CONNECTIONS = 256;

/** Bound on sessions per channel. Stops one bridge from monopolising NPROC. */
const DEFAULT_MAX_SESSIONS_PER_CHANNEL = 64;

/** Global session ceiling — same DoS budget across all channels. */
const DEFAULT_MAX_SESSIONS_TOTAL = 512;

/**
 * Per-field size caps applied in `parseOpenParams`. Frame-level cap
 * (16 MiB in protocol.ts) only catches the egregious case; these guard
 * against memory amplification across concurrent OPEN attempts.
 */
const MAX_SESSION_ID_BYTES = 64;
const MAX_SERVER_NAME_BYTES = 256;
const MAX_COMMAND_BYTES = 4096;
const MAX_ARG_BYTES = 65_536;
const MAX_ARG_COUNT = 256;
const MAX_ENV_KEY_BYTES = 256;
const MAX_ENV_VAL_BYTES = 65_536;
const MAX_ENV_COUNT = 512;
const MAX_CWD_BYTES = 4096;
const MAX_CLIENT_CAPS_BYTES = 64 * 1024;
const MAX_PROTOCOL_VERSION_BYTES = 64;
const MAX_CLIENT_INFO_NAME_BYTES = 256;
const MAX_CLIENT_INFO_VERSION_BYTES = 64;

/**
 * Phase D: cap on outbound bridge→child payloads buffered while a session is
 * in `draining` migration state. Beyond this, the daemon returns
 * `INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE` to the bridge so the client
 * can surface a retryable error rather than have the daemon's RAM grow
 * unbounded.
 */
const MAX_QUEUE_PER_SESSION = 256;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Env vars that hijack the dynamic linker / runtime loader of the spawned
 * child. Stripped from BOTH the daemon's inherited `process.env` and from
 * the bridge-supplied `resolvedEnv` before spawn — defense-in-depth so a
 * compromised bridge cannot make the daemon-spawned child load attacker
 * code (e.g. `LD_PRELOAD=/tmp/evil.so`, `NODE_OPTIONS=--require ...`).
 */
const ENV_VAR_DENYLIST = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_DEBUG",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_PRESERVE_SYMLINKS",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONHOME",
]);

const PROTOCOL_MISSING_FIELD: DaemonError = {
  code: ERROR_CODE_INVALID_REQUEST,
  message: "request missing required fields { id, method }",
};

export interface ChildGroup {
  groupId: string;
  upstreamHash: string;
  child: ChildHandle;
  rewriter: TokenRewriter;
  subscriptions: SubscriptionTracker;
  router: NotificationRouter;
  /** Sessions attached to this child. */
  sessions: Set<string>;
  /** Metadata captured at first spawn. */
  serverName: string;
  startedAt: number;
  /** Idle-child grace timer; non-null only when refcount==0. */
  graceTimer: NodeJS.Timeout | null;
  /** True once SIGTERM has been dispatched; new attaches must spawn fresh. */
  dying: boolean;
  /** True once the daemon has seen `notifications/initialized` from any session for this group. */
  initializedSeen: boolean;
  /** Phase D: runtime state — "shared" or "dedicated". */
  mode: "shared" | "dedicated";
  /** Phase D: config intent at OPEN time — "auto", "shared", or "dedicated". */
  sharing: "auto" | "shared" | "dedicated";
  /** Phase D: true once this group has triggered an auto-fork. */
  forked: boolean;
  /**
   * Phase D (Task 11): pending daemon-issued internal-request callbacks,
   * keyed by the negative id allocated for the request. The auto-fork
   * orchestrator uses this for `initialize`/`resources/subscribe` replay
   * against newly-spawned children.
   */
  internalRequests: Map<number, (payload: unknown) => void>;
  /**
   * Phase D (Task 11): next id to hand out for a daemon-issued request.
   * Starts at -1 and decrements (so first id is -1, then -2, …). Negative
   * ids are routed back through the registry by `TokenRewriter` returning
   * `kind: "internal"`.
   */
  nextInternalId: number;
}

/**
 * Phase D: per-session migration state machine for auto-fork.
 *
 * - `idle` — normal steady state; outbound traffic flows through the
 *   `group.child`.
 * - `draining` — a fork has been triggered. New outbound bridge→child traffic
 *   is queued in `queuedOutbound` (capped at `MAX_QUEUE_PER_SESSION`); the
 *   existing in-flight requests on the OLD child are allowed to drain. Once
 *   the new child is ready and replay completes, the queued payloads are
 *   sent and the session transitions to `migrated`.
 * - `migrated` — the session has switched over to its new group; this state
 *   is terminal for the migration cycle.
 */
type MigrationState =
  | { kind: "idle" }
  | {
      kind: "draining";
      newGroup: ChildGroup;
      queuedOutbound: unknown[];
      drainDeadline: number;
      drainTimer: NodeJS.Timeout | null;
      replayDone: boolean;
    }
  | { kind: "migrated" };

export interface SessionAttachment {
  sessionId: string;
  channel: FrameChannel;
  group: ChildGroup;
  startedAt: number;
  // Phase D additions:
  clientInfo: { name: string; version: string };
  clientCapabilities: Record<string, unknown>;
  protocolVersion: string;
  sharing: "auto" | "shared" | "dedicated";
  /** Original OPEN spec — needed by AutoForkOrchestrator to spawn replacement children. */
  openSpec: OpenParams["spec"];
  migration: MigrationState;
}

export interface ManagerOptions {
  socketPath: string;
  pidPath: string;
  lockPath: string;
  /** Daemon self-exits after `idleMs` of having no children/sessions. */
  idleMs: number;
  /** Idle-child grace before kill is dispatched. Default 60_000ms. */
  graceMs?: number;
  /** SIGTERM→SIGKILL window. Default 2_000ms. */
  killGraceMs?: number;
  /**
   * Phase D (Task 11): drain window for non-originating sessions during
   * an auto-fork migration, in ms. After this elapses with the OLD child
   * still busy, the session is evicted. Default 60_000ms.
   */
  autoForkDrainTimeoutMs?: number;
  /**
   * Phase D (Task 11): timeout for the daemon-issued initialize replay
   * against a fresh child during auto-fork migration, in ms. After this
   * elapses without a response, the new child is killed and the session
   * is evicted. Default 10_000ms.
   */
  autoForkInitializeTimeoutMs?: number;
  transport: Transport;
  /** Override pid for tests. */
  pid?: number;
  /** Cap on concurrent IPC connections. Defaults to 256. */
  maxConnections?: number;
  /** Cap on sessions per channel. Defaults to 64. */
  maxSessionsPerChannel?: number;
  /** Global cap on simultaneous sessions. Defaults to 512. */
  maxSessionsTotal?: number;
  /** Hook called once the manager has exited; tests await this. */
  onExit?: (code: number) => void;
  /** Optional logger; defaults to noop. */
  logger?: Logger;
  /**
   * Optional override for the process tracker file path. Defaults to the
   * daemon-co-located `~/.crabeye/run/processes.json` (or its Windows
   * equivalent).
   */
  processTrackerPath?: string;
  /** Pre-built tracker, used by tests to inject fakes. */
  processTracker?: ProcessTracker;
  /** Override for tests: skip real spawn. */
  _spawnChild?: (
    spec: OpenParams["spec"],
    callbacks: {
      onMessage: (payload: unknown) => void;
      onClose: () => void;
      onError: (err: Error) => void;
      onStderr: (line: string) => void;
    },
  ) => ChildHandle;
}

/**
 * Manager daemon. Owns the lockfile, pidfile, IPC server, and the spawned
 * STDIO upstream children. Sessions sharing a `upstreamHash` (and `auto`/
 * `shared` sharing mode) collapse onto a single child; `dedicated` sessions
 * always get their own.
 */
export class ManagerDaemon {
  private server: DaemonServer | null = null;
  private lock: LockHandle | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private connections = new Set<FrameChannel>();
  private groups = new Map<string, ChildGroup>();
  /** Phase D: index of currently-shareable groups, keyed by `${hash}:${sharing}`. dedicated entries never appear here. */
  private shareableIndex = new Map<string, ChildGroup>();
  /** Phase D: hashes where `auto` mode has triggered a fork. Future auto OPENs for these hashes spawn fresh dedicated. */
  private autoTainted = new Set<string>();
  private sessions = new Map<string, SessionAttachment>();
  private sessionsByChannel = new Map<FrameChannel, Set<string>>();
  private startedAt = 0;
  private stopping = false;
  private exited = false;
  private nextGroupCounter = 1;
  private readonly maxConnections: number;
  private readonly maxSessionsPerChannel: number;
  private readonly maxSessionsTotal: number;
  private readonly graceMs: number;
  private readonly killGraceMsValue: number;
  private readonly autoForkDrainTimeoutMs: number;
  private readonly autoForkInitializeTimeoutMs: number;
  private readonly logger: Logger;
  private readonly tracker: ProcessTracker;
  private readonly autoFork: AutoForkOrchestrator;
  private readonly telemetry = new Telemetry();
  private readonly exitedPromise: Promise<number>;
  private exitedResolve: (code: number) => void = () => {
    /* replaced in constructor */
  };

  constructor(private readonly opts: ManagerOptions) {
    this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxSessionsPerChannel = opts.maxSessionsPerChannel ?? DEFAULT_MAX_SESSIONS_PER_CHANNEL;
    this.maxSessionsTotal = opts.maxSessionsTotal ?? DEFAULT_MAX_SESSIONS_TOTAL;
    this.graceMs = opts.graceMs ?? 60_000;
    this.killGraceMsValue = opts.killGraceMs ?? 2_000;
    this.autoForkDrainTimeoutMs = opts.autoForkDrainTimeoutMs ?? 60_000;
    this.autoForkInitializeTimeoutMs = opts.autoForkInitializeTimeoutMs ?? 10_000;
    this.logger = opts.logger ?? createNoopLogger();
    this.tracker =
      opts.processTracker ??
      new ProcessTracker({
        filePath: opts.processTrackerPath ?? getProcessTrackerPath(),
        logger: this.logger.child({ component: "process-tracker" }),
      });
    this.autoFork = new AutoForkOrchestrator({
      logger: this.logger.child({ component: "auto-fork" }),
      sendToChild: (group, payload) => {
        try {
          group.child.send(payload);
        } catch (err) {
          this.logger.warn(
            `auto-fork sendToChild failed: ${err instanceof Error ? err.message : String(err)}`,
            { component: "auto-fork", upstreamHash: group.upstreamHash },
          );
        }
      },
      sendToSession: (group, sessionId, payload) => this.deliver(group, [sessionId], payload),
      warnedShared: new Set<string>(),
      taintAuto: (hash) => {
        const wasTainted = this.autoTainted.has(hash);
        this.autoTainted.add(hash);
        this.shareableIndex.delete(`${hash}:auto`);
        if (!wasTainted) this.telemetry.recordForkEvent();
      },
      delistShareable: (group, sharing) => {
        const key = `${group.upstreamHash}:${sharing}`;
        if (this.shareableIndex.get(key) === group) {
          this.shareableIndex.delete(key);
        }
      },
      spawnDedicatedForSession: (forSessionId) => {
        const att = this.sessions.get(forSessionId);
        if (att === undefined) return null;
        const spawned = this.spawnGroup(att.group.upstreamHash, att.openSpec, "dedicated");
        if (spawned instanceof Error) return null;
        this.groups.set(spawned.groupId, spawned);
        // Phase D (Task 11): move the session into the new group's `sessions`
        // set so STATUS reflects ownership of the new dedicated child, but
        // intentionally leave the OLD group's rewriter / subscriptions
        // untouched. Task 12's drain-detection hook waits for
        // `oldGroup.rewriter.inflightForSession(sid)` to reach zero before
        // the migration completes; if we tore down the old rewriter state
        // here, drain would be a no-op. `att.group` likewise stays pointing
        // at the OLD group until migration completes — outbound is buffered
        // in `att.migration.queuedOutbound` while draining, so it doesn't
        // route through `att.group` anyway.
        spawned.sessions.add(forSessionId);
        att.group.sessions.delete(forSessionId);
        // Don't register in shareableIndex — dedicated is never shareable.
        return spawned;
      },
      getAttachment: (sessionId) => this.sessions.get(sessionId),
      nextInternalId: (group) => {
        const id = group.nextInternalId;
        group.nextInternalId -= 1;
        return id;
      },
      registerInternal: (group, id, cb) => {
        group.internalRequests.set(id, cb);
      },
      unregisterInternal: (group, id) => {
        group.internalRequests.delete(id);
      },
      killGroup: (group) => {
        void this.unregisterGroup(group, "fork").catch(() => {});
      },
      evictSession: (sessionId, reason) => {
        const att = this.sessions.get(sessionId);
        if (att === undefined) return;
        // Send SESSION_EVICTED notification to bridge first; if we detached
        // first the channel cleanup could race the bridge's read of the frame.
        att.channel.send({
          method: "SESSION_EVICTED",
          params: { sessionId, reason } satisfies SessionEvictedParams,
        });
        // Force-detach via the standard path so rewriter / subscription /
        // grace-timer cleanup all run.
        void this.detachSession(sessionId, `auto-fork eviction: ${reason}`).catch(() => {});
      },
      urisForSession: (group, sessionId) => group.subscriptions.urisForSession(sessionId),
      registerSubscription: (group, sessionId, uri) => {
        group.subscriptions.subscribe(sessionId, uri);
      },
      attemptCompleteMigration: (oldGroup, newGroup, sessionId) => {
        const att = this.sessions.get(sessionId);
        if (att === undefined) return;
        if (att.migration.kind !== "draining") return;
        if (!att.migration.replayDone) return;
        const inflight = oldGroup.rewriter.inflightForSession(sessionId);
        if (inflight.length > 0) return;
        this.completeMigration(oldGroup, newGroup, sessionId);
      },
      completeMigration: (oldGroup, newGroup, sessionId) => {
        this.completeMigration(oldGroup, newGroup, sessionId);
      },
      synthDrainTimeoutErrors: (oldGroup, sessionId) => {
        const att = this.sessions.get(sessionId);
        if (att === undefined) return;
        const inflight = oldGroup.rewriter.inflightForSession(sessionId);
        for (const outerId of inflight) {
          const origin = oldGroup.rewriter.peekOrigin(outerId);
          if (origin === undefined) continue;
          this.sendInnerError(
            att.channel,
            sessionId,
            origin.originalId,
            INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT,
            "auto-fork drain timeout",
          );
        }
      },
      autoForkDrainTimeoutMs: this.autoForkDrainTimeoutMs,
      autoForkInitializeTimeoutMs: this.autoForkInitializeTimeoutMs,
    });
    this.exitedPromise = new Promise<number>((resolve) => {
      this.exitedResolve = resolve;
    });
  }

  /** Resolves with the exit code once `stop()` finishes. */
  waitForExit(): Promise<number> {
    return this.exitedPromise;
  }

  /**
   * Acquires the lock, writes the pidfile, reaps any stale children left
   * behind by a dead previous daemon, and binds the IPC server. Throws
   * `LockBusyError` if another live daemon is already running.
   */
  async start(): Promise<void> {
    await this.prepRunDir();

    this.lock = await acquireLock(this.opts.lockPath, {
      pid: this.opts.pid ?? process.pid,
    });

    let pidWritten = false;
    try {
      await writePidfile(this.opts.pidPath, this.opts.pid ?? process.pid);
      pidWritten = true;

      // Reap any subprocesses leaked by a previous daemon (crash, SIGKILL,
      // power loss). Done before binding the socket so a fresh OPEN can't
      // race with the reaper.
      try {
        const reaped = await this.tracker.reapStale();
        if (reaped.killed > 0 || reaped.skipped > 0) {
          this.logger.info(
            `reaped ${reaped.killed} leaked subprocess${reaped.killed === 1 ? "" : "es"} from previous daemon` +
              (reaped.skipped > 0 ? ` (${reaped.skipped} skipped due to PID reuse)` : ""),
            { component: "daemon" },
          );
        }
      } catch (err) {
        this.logger.warn(
          `failed to reap stale subprocesses: ${err instanceof Error ? err.message : String(err)}`,
          { component: "daemon" },
        );
      }

      this.server = this.opts.transport.createServer({
        path: this.opts.socketPath,
        onConnection: (channel) => this.handleConnection(channel),
      });

      await this.server.start();
      this.startedAt = Date.now();
      this.armIdleTimer();
    } catch (err) {
      if (pidWritten) {
        try {
          await unlink(this.opts.pidPath);
        } catch {
          /* best-effort */
        }
      }
      await this.releaseLock();
      throw err;
    }
  }

  /** Trigger graceful shutdown. Idempotent. */
  async stop(exitCode = 0): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Tear down all sessions before dropping connections so children get
    // a clean kill and the tracker is up-to-date.
    const sessionIds = Array.from(this.sessions.keys());
    for (const sid of sessionIds) {
      await this.detachSession(sid, "daemon shutdown").catch(() => {});
    }
    const groups = Array.from(this.groups.values());
    for (const g of groups) {
      await this.unregisterGroup(g, "shutdown").catch(() => {});
    }

    for (const ch of this.connections) {
      try {
        ch.close();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
    this.sessionsByChannel.clear();

    if (this.server !== null) {
      const srv = this.server;
      this.server = null;
      try {
        await srv.stop();
      } catch {
        /* swallowed during shutdown — refused unlinks etc. */
      }
    }

    try {
      await unlink(this.opts.pidPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write(`pidfile cleanup: ${(err as Error).message}\n`);
      }
    }

    await this.releaseLock();

    if (!this.exited) {
      this.exited = true;
      this.opts.onExit?.(exitCode);
      this.exitedResolve(exitCode);
    }
  }

  uptimeMs(): number {
    return this.startedAt === 0 ? 0 : Date.now() - this.startedAt;
  }

  /**
   * @internal Test seam for AIT-248 auto-fork. Sets a session's migration
   * state directly without going through the auto-fork orchestrator. DO NOT
   * call this from production code — it bypasses the spawn/replay machinery
   * and is only safe in unit tests that explicitly want to drive the
   * migration state machine by hand. No-ops if the session is unknown.
   */
  setMigrationStateForTest(sessionId: string, state: MigrationState): void {
    const att = this.sessions.get(sessionId);
    if (att !== undefined) att.migration = state;
  }

  /**
   * @internal Test seam for AIT-249 liveness tests. Replaces every active
   * server-side channel's inbound message handler with a no-op so frames
   * arriving from the bridge are silently dropped — simulates a stalled
   * daemon while keeping the socket open.
   */
  severFramesForTest(): void {
    for (const channel of this.connections) {
      channel.removeAllListeners("message");
      channel.on("message", () => { /* swallow */ });
    }
  }

  /**
   * @internal Test seam for AIT-248 auto-fork. Emits a server→child message
   * from the (single) currently-shared child as if it had arrived on the
   * child's stdout. Used by fork tests to synthesize server→client requests
   * without standing up a real upstream MCP server. Throws if no shared
   * group exists or if multiple shared groups are present (ambiguous).
   */
  spawnedChildEmitForTest(payload: unknown): void {
    const sharedGroups = Array.from(this.groups.values()).filter((g) => g.mode === "shared");
    if (sharedGroups.length === 0) throw new Error("no shared group to emit from");
    if (sharedGroups.length > 1) throw new Error("multiple shared groups; ambiguous");
    const group = sharedGroups[0]!;
    this.routeChildMessage(group, payload);
  }

  /** Manager-side request dispatch. Pure for STATUS and unknown_method. */
  handleRequest(req: DaemonRequest, channel?: FrameChannel): DaemonResponse | Promise<DaemonResponse> {
    if (
      typeof req !== "object" ||
      req === null ||
      typeof req.id !== "string" ||
      typeof req.method !== "string"
    ) {
      const id = (req as { id?: unknown })?.id;
      return {
        id: typeof id === "string" ? id : "",
        error: PROTOCOL_MISSING_FIELD,
      };
    }

    switch (req.method) {
      case "STATUS": {
        const result: StatusResult = {
          uptime: this.uptimeMs(),
          pid: this.opts.pid ?? process.pid,
          version: PROTOCOL_VERSION,
          children: this.statusChildren(),
          sessions: this.statusSessions(),
          telemetry: this.telemetry.snapshot(),
        };
        return { id: req.id, result };
      }
      case "SHUTDOWN":
        // setImmediate gives the response a chance to drain to the kernel
        // before stop() destroys the connection.
        setImmediate(() => {
          void this.stop(0);
        });
        return { id: req.id, result: { ok: true } };
      case "OPEN": {
        if (channel === undefined) {
          return errorResponse(req.id, ERROR_CODE_INVALID_REQUEST, "OPEN requires a channel");
        }
        return this.handleOpen(req.id, req.params, channel);
      }
      case "CLOSE":
        return this.handleClose(req.id, req.params);
      case "RESTART":
        return this.handleRestart(req.id, req.params);
      case "PING": {
        const params = req.params as Partial<PingParams> | undefined;
        if (
          params === undefined ||
          typeof params.seq !== "number" ||
          !Number.isInteger(params.seq) ||
          params.seq < 0
        ) {
          return errorResponse(
            req.id,
            ERROR_CODE_INVALID_PARAMS,
            "PING params must be { seq: non-negative integer }",
          );
        }
        const result: PingResult = { seq: params.seq };
        return { id: req.id, result };
      }
      default:
        return errorResponse(req.id, ERROR_CODE_UNKNOWN_METHOD, `unknown method "${req.method}"`);
    }
  }

  private handleConnection(channel: FrameChannel): void {
    if (this.stopping) {
      channel.close();
      return;
    }
    if (this.connections.size >= this.maxConnections) {
      channel.send({
        id: "",
        error: { code: ERROR_CODE_TOO_MANY_CONNECTIONS, message: "manager at connection cap" },
      });
      channel.close();
      return;
    }
    this.connections.add(channel);
    this.sessionsByChannel.set(channel, new Set());
    this.cancelIdleTimer();

    channel.on("message", (msg: unknown) => {
      void this.dispatchFrame(channel, msg);
    });

    channel.on("error", () => {
      /* swallow — close handler does the cleanup */
    });

    channel.on("close", () => {
      this.connections.delete(channel);
      const ownedSessions = this.sessionsByChannel.get(channel);
      this.sessionsByChannel.delete(channel);
      if (ownedSessions) {
        for (const sid of ownedSessions) {
          // Channel died: emit synthetic errors and detach.
          void this.detachSession(sid, "session closed").catch(() => {
            /* logged inside */
          });
        }
      }
      if (this.connections.size === 0 && this.sessions.size === 0 && this.groups.size === 0 && !this.stopping) {
        this.armIdleTimer();
      }
    });
  }

  private async dispatchFrame(channel: FrameChannel, msg: unknown): Promise<void> {
    if (isNotification(msg)) {
      await this.handleNotification(channel, msg);
      return;
    }
    if (isRequest(msg)) {
      this.telemetry.rpcInFlightInc();
      let res: DaemonResponse;
      try {
        res = await this.handleRequest(msg, channel);
      } finally {
        this.telemetry.rpcInFlightDec();
      }
      if (res.error !== undefined) this.telemetry.recordRpcError(res.error.code);
      channel.send(res);
      return;
    }
    // Response or malformed — daemon does not initiate requests yet, so a
    // response from the bridge is unexpected. Log and drop.
    this.logger.debug("dropping unexpected frame from peer", { component: "daemon" });
  }

  private async handleNotification(channel: FrameChannel, notif: DaemonNotification): Promise<void> {
    if (notif.method !== "RPC") {
      this.logger.debug(`unknown notification method "${notif.method}"`, { component: "daemon" });
      return;
    }
    const params = notif.params as Partial<RpcNotificationParams> | undefined;
    if (
      typeof params !== "object" ||
      params === null ||
      typeof params.sessionId !== "string" ||
      params.payload === undefined
    ) {
      this.logger.warn("RPC notification with invalid params", { component: "daemon" });
      return;
    }
    const att = this.sessions.get(params.sessionId);
    if (att === undefined || att.channel !== channel) {
      // Cross-channel session access is never legal; silently drop to
      // avoid leaking session existence.
      this.logger.debug("RPC for unknown session", {
        component: "daemon",
        sessionId: params.sessionId,
      });
      return;
    }
    const group = att.group;

    // Phase D auto-fork: while migrating, buffer outbound bridge→child
    // traffic on the OLD child. The new child takes over once initialize
    // replay completes (Task 12). Subscribe/unsubscribe and other dedupe
    // logic is intentionally deferred until after the buffer flush — we
    // want every payload (including subscribe replays from the bridge) to
    // queue uniformly while draining.
    if (att.migration.kind === "draining") {
      const innerId = pickInnerId(params.payload);
      if (att.migration.queuedOutbound.length >= MAX_QUEUE_PER_SESSION) {
        if (innerId !== null) {
          this.sendInnerError(
            channel,
            params.sessionId,
            innerId,
            INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE,
            "session migration buffer full",
          );
        }
        return;
      }
      att.migration.queuedOutbound.push(params.payload);
      return;
    }

    // Dedupe resources/subscribe and resources/unsubscribe.
    if (isResourceSubscribeRequest(params.payload)) {
      const reqId = pickInnerId(params.payload);
      const uri = subscribeUri(params.payload);
      if (uri === null) {
        if (reqId !== null) {
          channel.send({
            method: "RPC",
            params: {
              sessionId: params.sessionId,
              payload: {
                jsonrpc: "2.0",
                id: reqId,
                error: { code: -32602, message: "resources/subscribe missing or invalid 'uri' param" },
              },
            },
          });
        }
        return;
      }
      const isFirst = group.subscriptions.subscribe(params.sessionId, uri);
      if (reqId !== null) {
        channel.send({
          method: "RPC",
          params: {
            sessionId: params.sessionId,
            payload: { jsonrpc: "2.0", id: reqId, result: {} },
          },
        });
      }
      if (isFirst) {
        try {
          group.child.send({
            jsonrpc: "2.0",
            method: "resources/subscribe",
            params: { uri },
          });
        } catch (err) {
          this.logger.debug(
            `subscribe forward failed: ${err instanceof Error ? err.message : String(err)}`,
            { component: "daemon", upstreamHash: group.upstreamHash, uri },
          );
        }
      }
      return;
    }
    if (isResourceUnsubscribeRequest(params.payload)) {
      const reqId = pickInnerId(params.payload);
      const uri = subscribeUri(params.payload);
      if (uri === null) {
        if (reqId !== null) {
          channel.send({
            method: "RPC",
            params: {
              sessionId: params.sessionId,
              payload: {
                jsonrpc: "2.0",
                id: reqId,
                error: { code: -32602, message: "resources/unsubscribe missing or invalid 'uri' param" },
              },
            },
          });
        }
        return;
      }
      const isLast = group.subscriptions.unsubscribe(params.sessionId, uri);
      if (reqId !== null) {
        channel.send({
          method: "RPC",
          params: {
            sessionId: params.sessionId,
            payload: { jsonrpc: "2.0", id: reqId, result: {} },
          },
        });
      }
      if (isLast) {
        try {
          group.child.send({
            jsonrpc: "2.0",
            method: "resources/unsubscribe",
            params: { uri },
          });
        } catch (err) {
          this.logger.debug(
            `unsubscribe forward failed: ${err instanceof Error ? err.message : String(err)}`,
            { component: "daemon", upstreamHash: group.upstreamHash, uri },
          );
        }
      }
      return;
    }

    // Daemon-side initialize short-circuit.
    if (isInitializeRequest(params.payload) && group.child.cachedInit !== null) {
      const reqId = pickInnerId(params.payload);
      if (reqId !== null) {
        const initResult = group.child.cachedInit;
        channel.send({
          method: "RPC",
          params: {
            sessionId: params.sessionId,
            payload: {
              jsonrpc: "2.0",
              id: reqId,
              result: {
                protocolVersion: initResult.protocolVersion,
                serverInfo: initResult.serverInfo,
                capabilities: initResult.capabilities,
              },
            },
          },
        });
      }
      return;
    }
    // Drop subsequent notifications/initialized.
    if (isInitializedNotification(params.payload)) {
      if (group.initializedSeen) return;
      group.initializedSeen = true;
      // Fall through — first one forwards to child.
    }

    let rewritten: unknown;
    try {
      rewritten = group.rewriter.outboundForChild(params.payload, params.sessionId);
    } catch (err) {
      if (err instanceof InflightOverflowError) {
        const innerId = pickInnerId(params.payload);
        if (innerId !== null) {
          this.sendInnerError(channel, params.sessionId, innerId, INNER_ERROR_CODE_BACKPRESSURE, err.message);
        }
        return;
      }
      throw err;
    }
    if (rewritten === null) return;
    const allocatedOuterId = (rewritten as { id?: unknown })?.id;
    try {
      group.child.send(rewritten);
    } catch (err) {
      if (err instanceof BackpressureError) {
        const innerId = pickInnerId(params.payload);
        if (innerId !== null) {
          if (typeof allocatedOuterId === "number") {
            group.rewriter.removeInflight(params.sessionId, allocatedOuterId);
          }
          this.sendInnerError(channel, params.sessionId, innerId, INNER_ERROR_CODE_BACKPRESSURE, err.message);
        }
        return;
      }
      this.logger.warn(
        `child stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
        { component: "daemon", sessionId: params.sessionId },
      );
    }
  }

  private async handleOpen(
    requestId: string,
    rawParams: unknown,
    channel: FrameChannel,
  ): Promise<DaemonResponse> {
    const params = parseOpenParams(rawParams);
    if (params === null) {
      return errorResponse(requestId, ERROR_CODE_INVALID_PARAMS, "OPEN params malformed");
    }
    if (this.sessions.has(params.sessionId)) {
      return errorResponse(requestId, ERROR_CODE_INVALID_PARAMS, "sessionId already in use");
    }
    if (this.sessions.size >= this.maxSessionsTotal) {
      return errorResponse(
        requestId,
        ERROR_CODE_TOO_MANY_SESSIONS,
        `manager session cap reached (${this.maxSessionsTotal})`,
      );
    }
    const ownedNow = this.sessionsByChannel.get(channel)?.size ?? 0;
    if (ownedNow >= this.maxSessionsPerChannel) {
      return errorResponse(
        requestId,
        ERROR_CODE_TOO_MANY_SESSIONS,
        `channel session cap reached (${this.maxSessionsPerChannel})`,
      );
    }

    const hash = upstreamHash({
      serverName: params.spec.serverName,
      command: params.spec.command,
      args: params.spec.args,
      resolvedEnv: params.spec.resolvedEnv,
      cwd: params.spec.cwd,
    });

    const sharing = params.spec.sharing;
    let group: ChildGroup;

    const existing = this.findShareableGroup(hash, sharing);
    if (existing !== undefined) {
      group = existing;
      this.cancelGraceTimer(group);
    } else {
      // Determine spawn mode:
      // - sharing === "dedicated" → mode = "dedicated"
      // - sharing === "auto" && hash is tainted → mode = "dedicated" (no sharing allowed)
      // - otherwise → mode = "shared"
      const spawnMode: "shared" | "dedicated" =
        sharing === "dedicated" || (sharing === "auto" && this.autoTainted.has(hash))
          ? "dedicated"
          : "shared";
      const spawned = this.spawnGroup(hash, params.spec, spawnMode);
      if (spawned instanceof Error) {
        return errorResponse(requestId, ERROR_CODE_SPAWN_FAILED, spawned.message);
      }
      group = spawned;
    }
    this.groups.set(group.groupId, group);

    group.rewriter.attachSession(params.sessionId);
    group.sessions.add(params.sessionId);

    const attachment: SessionAttachment = {
      sessionId: params.sessionId,
      channel,
      group,
      startedAt: Date.now(),
      clientInfo: params.spec.clientInfo,
      clientCapabilities: params.spec.clientCapabilities,
      protocolVersion: params.spec.protocolVersion,
      sharing: params.spec.sharing,
      openSpec: params.spec,
      migration: { kind: "idle" },
    };
    this.sessions.set(params.sessionId, attachment);
    this.telemetry.recordSessionOpen();
    const owned = this.sessionsByChannel.get(channel) ?? new Set<string>();
    owned.add(params.sessionId);
    this.sessionsByChannel.set(channel, owned);
    this.cancelIdleTimer();

    return { id: requestId, result: { ok: true } };
  }

  /**
   * Find the currently shareable group for (hash, sharing). Returns undefined if
   * no shareable group exists, or if `sharing === "dedicated"` (dedicated groups
   * are never indexed), or if `sharing === "auto"` and the hash is tainted.
   */
  private findShareableGroup(
    hash: string,
    sharing: "auto" | "shared" | "dedicated",
  ): ChildGroup | undefined {
    if (sharing === "dedicated") return undefined;
    if (sharing === "auto" && this.autoTainted.has(hash)) return undefined;
    const key = `${hash}:${sharing}`;
    const group = this.shareableIndex.get(key);
    if (group === undefined || group.dying) return undefined;
    return group;
  }

  private spawnGroup(
    hash: string,
    spec: OpenParams["spec"],
    mode: "shared" | "dedicated",
  ): ChildGroup | Error {
    const rewriter = new TokenRewriter();
    const subscriptions = new SubscriptionTracker();
    const router = new NotificationRouter();
    const groupRef: { value: ChildGroup | null } = { value: null };

    const callbacks = {
      onMessage: (payload: unknown): void => {
        const g = groupRef.value;
        if (g !== null) this.routeChildMessage(g, payload);
      },
      onClose: (): void => {
        const g = groupRef.value;
        if (g !== null) this.handleChildExit(g);
      },
      onError: (err: Error): void => {
        this.logger.warn(`child error: ${err.message}`, { component: "daemon", upstreamHash: hash });
      },
      onStderr: (line: string): void => {
        this.logger.debug(line, { component: "daemon", upstreamHash: hash, stream: "stderr" });
      },
    };

    let child: ChildHandle;
    try {
      child = this.opts._spawnChild
        ? this.opts._spawnChild(spec, callbacks)
        : new ChildHandle({
            command: spec.command,
            args: spec.args,
            env: buildSpawnEnv(spec.resolvedEnv),
            cwd: spec.cwd === "" ? undefined : spec.cwd,
            ...callbacks,
          });
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }

    const group: ChildGroup = {
      groupId: `${hash}:${spec.sharing}:${this.nextGroupCounter++}`,
      upstreamHash: hash,
      child,
      rewriter,
      subscriptions,
      router,
      sessions: new Set(),
      serverName: spec.serverName,
      startedAt: child.startedAt,
      graceTimer: null,
      dying: false,
      initializedSeen: false,
      mode,
      sharing: spec.sharing,
      forked: false,
      internalRequests: new Map(),
      nextInternalId: -1,
    };
    groupRef.value = group;

    if (mode === "shared") {
      this.shareableIndex.set(`${hash}:${spec.sharing}`, group);
    }

    this.telemetry.recordSpawn();

    if (child.pid !== null) {
      void this.tracker
        .register({
          pid: child.pid,
          command: spec.command,
          args: spec.args,
          server: spec.serverName,
          startedAt: child.startedAt,
        })
        .catch((err) => {
          this.logger.warn(
            `failed to record spawned subprocess: ${err instanceof Error ? err.message : String(err)}`,
            { component: "daemon", pid: child.pid },
          );
        });
    }

    return group;
  }

  private async handleClose(requestId: string, rawParams: unknown): Promise<DaemonResponse> {
    const params = parseCloseParams(rawParams);
    if (params === null) {
      return errorResponse(requestId, ERROR_CODE_INVALID_PARAMS, "CLOSE params malformed");
    }
    if (!this.sessions.has(params.sessionId)) {
      return errorResponse(requestId, ERROR_CODE_SESSION_NOT_FOUND, "no such session");
    }
    await this.detachSession(params.sessionId, "session closed");
    return { id: requestId, result: { ok: true } };
  }

  /**
   * Admin RESTART: kill the child group(s) matching `params.upstreamHash`.
   *
   * Before tearing each group down we surface a typed JSON-RPC error
   * (`upstream_restarted`, `data.reason: "admin_restart"`) to every
   * attached session for any in-flight request, so the bridge sees the
   * intended cause instead of the generic `session_closed` that
   * detachSession() would otherwise emit when the child exits underneath.
   */
  private handleRestart(reqId: string, rawParams: unknown): DaemonResponse {
    const params = parseRestartParams(rawParams);
    if (params === null) {
      return errorResponse(
        reqId,
        ERROR_CODE_INVALID_PARAMS,
        "RESTART params must be { upstreamHash: string }",
      );
    }
    const hash = params.upstreamHash;
    // Snapshot before iterating: unregisterGroup() mutates this.groups.
    const matched = Array.from(this.groups.values()).filter(
      (g) => g.upstreamHash === hash,
    );
    for (const group of matched) {
      for (const sid of Array.from(group.sessions)) {
        const att = this.sessions.get(sid);
        if (att === undefined) continue;
        this.sendRestartedError(att, "admin_restart");
      }
      void this.unregisterGroup(group, "restart").catch(() => {
        /* logged elsewhere */
      });
    }
    const result: RestartResult = { ok: true, killed: matched.length };
    return { id: reqId, result };
  }

  /**
   * Synthesize an `upstream_restarted` JSON-RPC error for every in-flight
   * request on the given session, framed inside an `RPC` notification so the
   * bridge sees it as a regular response.
   */
  private sendRestartedError(att: SessionAttachment, reason: UpstreamRestartedReason): void {
    const inflight = att.group.rewriter.inflightForSession(att.sessionId);
    for (const outerId of inflight) {
      const origin = att.group.rewriter.peekOrigin(outerId);
      if (origin === undefined) continue;
      this.sendUpstreamRestartedError(att.channel, att.sessionId, origin.originalId, reason);
    }
  }

  /**
   * Route an inbound child→bridge message to the correct session(s).
   * - "response" / "progress" / "cancelled": sessionIds from rewriter (originating session)
   * - "drop": silently discard
   * - "other": defer to NotificationRouter for fan-out across all attached sessions
   */
  private routeChildMessage(group: ChildGroup, payload: unknown): void {
    const routing = group.rewriter.inboundFromChild(payload);
    if (routing.kind === "drop") return;
    if (routing.kind === "response") {
      // Capture cachedInit from the first initialize response.
      // Heuristic: any first response with protocolVersion+serverInfo+capabilities triple is treated as the
      // initialize result. This is safe because initialize is the only request-with-result of this shape
      // sent before any other traffic in the MCP protocol. False-positive risk is negligible.
      if (group.child.cachedInit === null) {
        const restored = routing.payload as { id?: unknown; result?: unknown };
        const result = restored.result as
          | { protocolVersion?: unknown; serverInfo?: unknown; capabilities?: unknown }
          | undefined;
        if (
          result !== undefined &&
          typeof result.protocolVersion === "string" &&
          typeof result.serverInfo === "object" &&
          result.serverInfo !== null &&
          typeof result.capabilities === "object" &&
          result.capabilities !== null
        ) {
          group.child.setCachedInit({
            protocolVersion: result.protocolVersion,
            serverInfo: result.serverInfo as CachedInit["serverInfo"],
            capabilities: result.capabilities as Record<string, unknown>,
          });
        }
      }
      this.deliver(group, routing.sessionIds, routing.payload);
      // Phase D (Task 12): after delivering a response, check whether any of
      // these sessions are in a draining migration with this group as their
      // OLD group. If so, attempt completion now that another inflight has
      // resolved.
      for (const sid of routing.sessionIds) {
        const att = this.sessions.get(sid);
        if (att === undefined) continue;
        if (att.migration.kind !== "draining") continue;
        const newGroup = att.migration.newGroup;
        this.autoFork.onSessionInflightChanged(group, newGroup, sid);
      }
      return;
    }
    if (routing.kind === "progress" || routing.kind === "cancelled") {
      this.deliver(group, routing.sessionIds, routing.payload);
      return;
    }
    // Phase D (Task 11): daemon-issued internal requests resolve via the
    // per-group registry. Lookup the pending callback by negative id and
    // remove it from the map (callbacks fire exactly once).
    if (routing.kind === "internal") {
      const id = (routing.payload as { id?: number }).id;
      if (typeof id === "number") {
        const cb = group.internalRequests.get(id);
        if (cb !== undefined) {
          group.internalRequests.delete(id);
          cb(routing.payload);
        }
      }
      return;
    }
    // "other" — could be a server→client request or a notification.
    if (this.autoFork.isServerRequest(routing.payload)) {
      void this.autoFork.handleServerRequest(group, routing.payload);
      return;
    }
    // Notification — fan out via NotificationRouter (existing behavior).
    const sessions = group.router.route(routing.payload, Array.from(group.sessions), group.subscriptions);
    if (sessions.length > 0) this.deliver(group, sessions, routing.payload);
  }

  /**
   * Phase D (Task 12): finalize a session's auto-fork migration. Drops old
   * group's subscription/rewriter state for the session, swings `att.group`
   * to the new group, attaches to the new rewriter, and flushes the queued
   * outbound buffer through the new child. Idempotent in the sense that it
   * no-ops if the session is no longer draining.
   */
  private completeMigration(oldGroup: ChildGroup, newGroup: ChildGroup, sessionId: string): void {
    const att = this.sessions.get(sessionId);
    if (att === undefined) return;
    if (att.migration.kind !== "draining") return;

    // Drop subscriptions on old group, send unsubscribes for URIs that lose last subscriber.
    const droppedUris = oldGroup.subscriptions.removeSession(sessionId);
    for (const uri of droppedUris) {
      try {
        oldGroup.child.send({
          jsonrpc: "2.0",
          method: "resources/unsubscribe",
          params: { uri },
        });
      } catch {
        /* best-effort */
      }
    }

    // Detach from old group's rewriter (cancels any outstanding outerIds — but we
    // expect inflight to be empty at this point).
    oldGroup.rewriter.detachSession(sessionId);

    // Note: Task 11's fork already moved sessionId from oldGroup.sessions to newGroup.sessions
    // (for STATUS visibility). Don't re-do that. Just attach to the new rewriter.
    newGroup.rewriter.attachSession(sessionId);
    att.group = newGroup;

    // Flush queued outbound to new child.
    const queue = att.migration.queuedOutbound;
    const drainTimer = att.migration.drainTimer;
    if (drainTimer !== null) clearTimeout(drainTimer);
    att.migration = { kind: "migrated" };

    for (const payload of queue) {
      // Re-enter the outbound path on the new group via a synthetic local handler.
      // We can't recursively call handleNotification here (it expects an RPC notif
      // wrapper). Instead, replicate the core: rewriter.outboundForChild + child.send.
      let rewritten: unknown;
      try {
        rewritten = newGroup.rewriter.outboundForChild(payload, sessionId);
      } catch (err) {
        this.logger.warn(
          `auto-fork: failed to rewrite queued payload after migration: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { component: "auto-fork", sessionId, upstreamHash: newGroup.upstreamHash },
        );
        continue;
      }
      if (rewritten === null) continue;
      try {
        newGroup.child.send(rewritten);
      } catch (err) {
        this.logger.warn(
          `auto-fork: queued payload send failed after migration: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { component: "auto-fork", sessionId, upstreamHash: newGroup.upstreamHash },
        );
      }
    }
  }

  private deliver(group: ChildGroup, sessionIds: string[], payload: unknown): void {
    for (const sid of sessionIds) {
      const att = this.sessions.get(sid);
      if (att === undefined) continue;
      const ok = att.channel.send({ method: "RPC", params: { sessionId: sid, payload } });
      if (!ok) {
        this.logger.debug("RPC notification dropped (backpressure)", {
          component: "daemon",
          sessionId: sid,
          upstreamHash: group.upstreamHash,
        });
      }
    }
  }

  private handleChildExit(group: ChildGroup): void {
    // Phase D (Task 16): sessions whose old group is dying may be mid-migration.
    // For each draining session, give the orchestrator a chance to finalize
    // against the new child (treating old-child inflight as terminated).
    // Sessions still in idle on this group take the standard detach path.
    const sessionIds = Array.from(group.sessions);

    // Snapshot draining sessions whose OLD group is the one that just died.
    // Note: at fork time (Task 11) we moved migrating sessions OUT of
    // `oldGroup.sessions` and INTO `newGroup.sessions`, so iterating
    // `group.sessions` won't surface them. We instead scan `this.sessions` for
    // any draining attachment whose `att.group` (still pointing at old group
    // during draining) equals the dying group.
    const drainingSessions: Array<{ sessionId: string; newGroup: ChildGroup }> = [];
    for (const att of this.sessions.values()) {
      if (att.migration.kind !== "draining") continue;
      if (att.group !== group) continue;
      drainingSessions.push({ sessionId: att.sessionId, newGroup: att.migration.newGroup });
    }

    // For each draining session, attempt completion. If replay is done and
    // old-child inflight is now treated as zero (rewriter detach hasn't run
    // yet, but we attempt anyway — the manager-side hook checks inflight on
    // the old rewriter), it'll finalize. If not, the session stays draining;
    // it'll either complete when replay finishes or hit the drain timeout.
    for (const { sessionId, newGroup } of drainingSessions) {
      this.autoFork.onSessionInflightChanged(group, newGroup, sessionId);
    }

    // Detach all sessions still attached to this old group (originating session
    // and any non-draining sessions). Draining sessions that already migrated
    // away (att.group === newGroup after completeMigration) are skipped.
    for (const sid of sessionIds) {
      const att = this.sessions.get(sid);
      if (att === undefined) continue;
      if (att.group !== group) continue; // already migrated away
      void this.detachSession(sid, "child process exited").catch(() => {});
    }

    void this.unregisterGroup(group, "crash").catch(() => {});
  }

  /**
   * Detach a session from its group. Emits synthetic session_closed errors
   * for in-flight requests, decrements refcount, arms the grace timer at 0.
   * Does NOT kill the child unless the grace timer expires.
   */
  private async detachSession(sessionId: string, reason: string): Promise<void> {
    const att = this.sessions.get(sessionId);
    if (att === undefined) return;

    // Phase D (Task 13): if the session was mid-migration, clean up the new
    // group and its drain timer before the standard detach path runs. The
    // standard path operates on `att.group`, which is still the OLD group
    // until completeMigration swings it — so the new group won't get cleaned
    // up otherwise.
    if (att.migration.kind === "draining") {
      if (att.migration.drainTimer !== null) {
        clearTimeout(att.migration.drainTimer);
        att.migration.drainTimer = null;
      }
      // Drop any unflushed payloads — bridge will reconnect.
      att.migration.queuedOutbound.length = 0;
      // Kill the not-yet-attached new child if it has no other sessions
      // (or only this one).
      const newGroup = att.migration.newGroup;
      if (
        newGroup.sessions.size === 0 ||
        (newGroup.sessions.size === 1 && newGroup.sessions.has(sessionId))
      ) {
        void this.unregisterGroup(newGroup, "fork").catch(() => {});
      }
    }

    this.sessions.delete(sessionId);
    this.telemetry.recordSessionClose();

    const owned = this.sessionsByChannel.get(att.channel);
    if (owned) owned.delete(sessionId);

    const group = att.group;
    group.sessions.delete(sessionId);

    // Synthetic errors for inflight requests.
    // Peek originals BEFORE detachSession (which clears the origin map).
    const inflight = group.rewriter.inflightForSession(sessionId);
    const originals: InnerId[] = [];
    for (const outerId of inflight) {
      const origin = group.rewriter.peekOrigin(outerId);
      if (origin !== undefined) originals.push(origin.originalId);
    }

    // Drop subscriptions; collect URIs that lost their last subscriber.
    const droppedUris = group.subscriptions.removeSession(sessionId);

    // Detach session from rewriter; collect outer ids to cancel on the child.
    const { cancelledOuterIds } = group.rewriter.detachSession(sessionId);

    // Send synthetic errors AFTER detach so rewriter state is clean.
    for (const innerId of originals) {
      this.sendInnerError(att.channel, sessionId, innerId, INNER_ERROR_CODE_SESSION_CLOSED, reason);
    }

    // Forward `notifications/cancelled` to the child for each outstanding outer id.
    for (const outerId of cancelledOuterIds) {
      try {
        group.child.send({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: outerId, reason: "session detached" },
        });
      } catch {
        /* child may be dying; best-effort */
      }
    }

    // Forward `resources/unsubscribe` to the child for each URI that lost all subscribers.
    for (const uri of droppedUris) {
      try {
        group.child.send({
          jsonrpc: "2.0",
          method: "resources/unsubscribe",
          params: { uri },
        });
      } catch {
        /* best-effort */
      }
    }

    if (group.sessions.size === 0) {
      this.armGraceTimer(group);
    }

    if (this.connections.size === 0 && this.sessions.size === 0 && this.groups.size === 0 && !this.stopping) {
      this.armIdleTimer();
    }
  }

  private armGraceTimer(group: ChildGroup): void {
    this.cancelGraceTimer(group);
    if (this.graceMs === 0) {
      void this.expireGroup(group);
      return;
    }
    group.graceTimer = setTimeout(() => {
      void this.expireGroup(group);
    }, this.graceMs);
    if (typeof group.graceTimer.unref === "function") group.graceTimer.unref();
  }

  private async expireGroup(group: ChildGroup): Promise<void> {
    if (group.sessions.size > 0) return; // re-attached during the window
    group.dying = true;
    group.graceTimer = null;
    await this.unregisterGroup(group, "grace").catch(() => {});
    if (this.connections.size === 0 && this.sessions.size === 0 && this.groups.size === 0 && !this.stopping) {
      this.armIdleTimer();
    }
  }

  private cancelGraceTimer(group: ChildGroup): void {
    if (group.graceTimer !== null) {
      clearTimeout(group.graceTimer);
      group.graceTimer = null;
    }
  }

  private async unregisterGroup(
    group: ChildGroup,
    reason: KilledReason | "shutdown",
  ): Promise<void> {
    if (this.groups.get(group.groupId) === group) {
      this.groups.delete(group.groupId);
      // Counters reflect lifecycle events while the daemon is alive; don't
      // count children torn down during stop().
      if (reason !== "shutdown") this.telemetry.recordKill(reason);
    }
    // Remove from shareable index if this group is the indexed one.
    const indexKey = `${group.upstreamHash}:${group.sharing}`;
    if (this.shareableIndex.get(indexKey) === group) {
      this.shareableIndex.delete(indexKey);
    }
    this.cancelGraceTimer(group);
    const pid = group.child.pid;
    try {
      await group.child.kill(this.killGraceMs());
    } catch {
      /* best-effort */
    }
    if (pid !== null) {
      try {
        await this.tracker.unregister(pid);
      } catch {
        /* best-effort */
      }
    }
  }

  private killGraceMs(): number {
    return this.killGraceMsValue;
  }

  /**
   * Wrap a synthetic JSON-RPC error in an `RPC` notification frame so the
   * bridge's MCP client receives it as a normal response.
   */
  private sendInnerError(
    channel: FrameChannel,
    sessionId: string,
    innerId: InnerId,
    code: number,
    message: string,
  ): void {
    const payload = {
      jsonrpc: "2.0",
      id: innerId,
      error: { code, message },
    };
    channel.send({
      method: "RPC",
      params: { sessionId, payload },
    });
  }

  private sendUpstreamRestartedError(
    channel: FrameChannel,
    sessionId: string,
    innerId: InnerId,
    reason: UpstreamRestartedReason,
  ): void {
    // MCP SDK's JSONRPCErrorResponseSchema requires `code: number`; the
    // human-readable discriminator lives in `data.reason`.
    const payload = {
      jsonrpc: "2.0",
      id: innerId,
      error: {
        code: INNER_ERROR_CODE_UPSTREAM_RESTARTED,
        message: `upstream restarted (${reason})`,
        data: { reason },
      },
    };
    channel.send({
      method: "RPC",
      params: { sessionId, payload },
    });
  }

  private statusChildren(): StatusChild[] {
    return Array.from(this.groups.values()).map((g) => ({
      pid: g.child.pid ?? -1,
      upstreamHash: g.upstreamHash,
      startedAt: g.startedAt,
      refcount: g.sessions.size,
      sessions: Array.from(g.sessions),
      subscriptionCount: g.subscriptions.subscriptionCount(),
      mode: g.mode,
      sharing: g.sharing,
      forked: g.forked,
      cachedInit:
        g.child.cachedInit === null
          ? null
          : { protocolVersion: g.child.cachedInit.protocolVersion },
    }));
  }

  private statusSessions(): StatusSession[] {
    return Array.from(this.sessions.values()).map((a) => ({
      sessionId: a.sessionId,
      upstreamHash: a.group.upstreamHash,
      serverName: a.group.serverName,
    }));
  }

  private armIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.stopping && this.connections.size === 0 && this.sessions.size === 0 && this.groups.size === 0) {
        void this.stop(0);
      }
    }, this.opts.idleMs);
    if (typeof this.idleTimer.unref === "function") {
      this.idleTimer.unref();
    }
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async releaseLock(): Promise<void> {
    if (this.lock === null) return;
    const lock = this.lock;
    this.lock = null;
    await lock.release();
  }

  private async prepRunDir(): Promise<void> {
    const dir = dirname(this.opts.lockPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (isWindows) return;

    // mkdir-recursive resolves intermediate symlinks. Refuse the run dir if
    // it's been replaced with a symlink (same-UID redirection attempt).
    const st = await lstat(dir);
    if (st.isSymbolicLink()) {
      throw new Error(`refusing to use symlinked daemon run dir: ${dir}`);
    }
    await chmod(dir, 0o700);
  }
}

function errorResponse(id: string, code: string, message: string): DaemonResponse {
  return { id, error: { code, message } };
}

function parseOpenParams(raw: unknown): OpenParams | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { sessionId?: unknown; spec?: unknown };
  if (typeof r.sessionId !== "string" || !UUID_RE.test(r.sessionId)) return null;
  if (r.sessionId.length > MAX_SESSION_ID_BYTES) return null;
  const spec = r.spec;
  if (typeof spec !== "object" || spec === null) return null;
  const s = spec as Record<string, unknown>;
  if (typeof s.serverName !== "string" || s.serverName.length > MAX_SERVER_NAME_BYTES) return null;
  if (typeof s.command !== "string" || s.command.length === 0 || s.command.length > MAX_COMMAND_BYTES) return null;
  if (!Array.isArray(s.args) || s.args.length > MAX_ARG_COUNT) return null;
  for (const a of s.args) {
    if (typeof a !== "string" || a.length > MAX_ARG_BYTES) return null;
  }
  if (typeof s.resolvedEnv !== "object" || s.resolvedEnv === null || Array.isArray(s.resolvedEnv)) {
    return null;
  }
  const envEntries = Object.entries(s.resolvedEnv);
  if (envEntries.length > MAX_ENV_COUNT) return null;
  for (const [k, v] of envEntries) {
    if (k.length > MAX_ENV_KEY_BYTES) return null;
    if (typeof v !== "string" || v.length > MAX_ENV_VAL_BYTES) return null;
  }
  if (typeof s.cwd !== "string" || s.cwd.length > MAX_CWD_BYTES) return null;
  // Reject relative cwd: it would resolve against the daemon's cwd (whatever
  // shell launched the daemon), almost never the bridge's intent.
  if (s.cwd !== "" && !isAbsolute(s.cwd)) return null;
  if (s.sharing !== "auto" && s.sharing !== "shared" && s.sharing !== "dedicated") return null;
  if (typeof s.protocolVersion !== "string" || s.protocolVersion.length === 0
      || s.protocolVersion.length > MAX_PROTOCOL_VERSION_BYTES) return null;
  if (typeof s.clientInfo !== "object" || s.clientInfo === null || Array.isArray(s.clientInfo)) return null;
  const ci = s.clientInfo as { name?: unknown; version?: unknown };
  if (typeof ci.name !== "string" || ci.name.length === 0 || ci.name.length > MAX_CLIENT_INFO_NAME_BYTES) return null;
  if (typeof ci.version !== "string" || ci.version.length === 0 || ci.version.length > MAX_CLIENT_INFO_VERSION_BYTES) return null;
  if (typeof s.clientCapabilities !== "object" || s.clientCapabilities === null
      || Array.isArray(s.clientCapabilities)) return null;
  const capsJson = JSON.stringify(s.clientCapabilities);
  if (capsJson.length > MAX_CLIENT_CAPS_BYTES) return null;

  return {
    sessionId: r.sessionId,
    spec: {
      serverName: s.serverName,
      command: s.command,
      args: s.args as string[],
      resolvedEnv: s.resolvedEnv as Record<string, string>,
      cwd: s.cwd,
      sharing: s.sharing as "auto" | "shared" | "dedicated",
      clientInfo: { name: ci.name, version: ci.version },
      clientCapabilities: s.clientCapabilities as Record<string, unknown>,
      protocolVersion: s.protocolVersion,
    },
  };
}

/**
 * Build the env block for `spawn`. Filters `undefined` values out of
 * `process.env` (the type is `string | undefined`; spreading without
 * filtering produces literal `"undefined"` env var values), and strips the
 * dynamic-linker / runtime-loader env vars from BOTH the daemon's inherited
 * env and the bridge-supplied `resolvedEnv`. Bridge-supplied `resolvedEnv`
 * still wins on key collision for non-denied keys.
 */
function buildSpawnEnv(resolvedEnv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (ENV_VAR_DENYLIST.has(k)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(resolvedEnv)) {
    if (ENV_VAR_DENYLIST.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function parseRestartParams(raw: unknown): RestartParams | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.upstreamHash !== "string" || r.upstreamHash.length === 0) return null;
  return { upstreamHash: r.upstreamHash };
}

function parseCloseParams(raw: unknown): CloseParams | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { sessionId?: unknown };
  if (typeof r.sessionId !== "string" || r.sessionId.length === 0) return null;
  return { sessionId: r.sessionId };
}

function pickInnerId(payload: unknown): InnerId | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { id?: unknown };
  if (typeof p.id === "string" || typeof p.id === "number") return p.id;
  return null;
}

function isInitializeRequest(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as { method?: unknown; id?: unknown };
  return p.method === "initialize" && (typeof p.id === "string" || typeof p.id === "number");
}

function isInitializedNotification(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as { method?: unknown };
  return p.method === "notifications/initialized";
}

function isResourceSubscribeRequest(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as { method?: unknown };
  return p.method === "resources/subscribe";
}

function isResourceUnsubscribeRequest(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as { method?: unknown };
  return p.method === "resources/unsubscribe";
}

function subscribeUri(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { params?: unknown };
  if (typeof p.params !== "object" || p.params === null) return null;
  const params = p.params as { uri?: unknown };
  return typeof params.uri === "string" ? params.uri : null;
}

/**
 * Write the pidfile with `O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW` to refuse
 * pre-existing symlinks. The lockfile already pins our slot, so the file
 * shouldn't exist; if it does, fail loudly.
 */
async function writePidfile(path: string, pid: number): Promise<void> {
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    fsConstants.O_WRONLY |
    (isWindows ? 0 : fsConstants.O_NOFOLLOW);
  let fh;
  try {
    fh = await open(path, flags, 0o600);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      try {
        const st = await lstat(path);
        if (st.isSymbolicLink()) {
          throw new Error(`refusing to write pidfile: ${path} is a symlink`);
        }
      } catch (lstatErr) {
        if ((lstatErr as NodeJS.ErrnoException).code !== "ENOENT") throw lstatErr;
      }
      await unlink(path).catch(() => {
        /* race tolerated; retry will surface it */
      });
      fh = await open(path, flags, 0o600);
    } else {
      throw err;
    }
  }
  try {
    await fh.writeFile(`${pid}\n`, "utf-8");
  } finally {
    await fh.close();
  }
}

export { LockBusyError };
export type { MigrationState };
