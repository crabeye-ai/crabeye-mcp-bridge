import { open, lstat, mkdir, chmod, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { APP_NAME, APP_VERSION, DEFAULT_KILL_GRACE_MS, UPSTREAM_MARKER_ENV } from "../constants.js";
import { createNoopLogger, methodLabel, type Logger } from "../logging/index.js";
import { upstreamHash } from "../upstream/upstream-hash.js";
import {
  acquireLock,
  LockBusyError,
  readLockHolderPid,
  sweepAbandonedLockFiles,
  type LockHandle,
} from "./lockfile.js";
import { processExists } from "../process/process-utils.js";
import { isForeignProcess } from "./daemon-identity.js";
import { ChildHandle, BackpressureError } from "./child-handle.js";
import type { CachedInit, ProcessExit } from "./child-handle.js";
import { ProcessTracker } from "./process-tracker.js";
import { processTrackerPathFor } from "./paths.js";
import {
  ERROR_CODE_INVALID_PARAMS,
  ERROR_CODE_SESSION_IN_USE,
  ERROR_CODE_INVALID_REQUEST,
  ERROR_CODE_SESSION_NOT_FOUND,
  ERROR_CODE_SPAWN_FAILED,
  ERROR_CODE_TOO_MANY_CONNECTIONS,
  ERROR_CODE_BRIDGE_UNSUPPORTED,
  ERROR_CODE_DAEMON_STOPPING,
  ERROR_CODE_TOO_MANY_SESSIONS,
  ERROR_CODE_UNKNOWN_METHOD,
  INNER_ERROR_CODE_UPSTREAM_RESTARTED,
  INNER_ERROR_CODE_BACKPRESSURE,
  INNER_ERROR_CODE_SESSION_CLOSED,
  MIN_BRIDGE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  STDERR_BRIDGE_PROTOCOL_VERSION,
  UNREPORTED_BRIDGE_PROTOCOL_VERSION,
  isNotification,
  isRequest,
  type ChildExit,
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
  type StderrParams,
  type UpstreamRestartedReason,
} from "./protocol.js";
import { InflightOverflowError, TokenRewriter, type InnerId } from "./token-rewriter.js";
import { SubscriptionTracker } from "./subscription-tracker.js";
import { NotificationRouter } from "./notification-router.js";
import { answerChildRequest, isChildRequest, type ChildRequest } from "./child-requests.js";
import { Telemetry, type KilledReason } from "./telemetry.js";
import { ChildPing } from "./child-ping.js";
import { StderrForwardLimit } from "./stderr-capture.js";
import { SocketInUseError, type DaemonServer, type FrameChannel, type Transport } from "./transport.js";

const isWindows = process.platform === "win32";
const PUBLICATION_CHECK_MS = 5_000;
const PREDECESSOR_POLL_MS = 25;
const PREDECESSOR_RECHECK_MS = 1_000;
const MAX_EARLY_MESSAGES = 64;

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
  stderrLimit: StderrForwardLimit;
  /** Sessions attached to this child. */
  sessions: Set<string>;
  /** Metadata captured at first spawn. */
  serverName: string;
  startedAt: number;
  /** Idle-child grace timer; non-null only when refcount==0. */
  graceTimer: NodeJS.Timeout | null;
  /** True once the daemon has seen `notifications/initialized` from any session for this group. */
  initializedSeen: boolean;
  /**
   * Pending daemon-issued internal-request callbacks (child pings), keyed by
   * the negative id allocated for the request.
   */
  internalRequests: Map<number, (payload: unknown) => void>;
  /**
   * Next id to hand out for a daemon-issued request.
   * Starts at -1 and decrements (so first id is -1, then -2, …). Negative
   * ids are routed back through the registry by `TokenRewriter` returning
   * `kind: "internal"`.
   */
  nextInternalId: number;
  /**
   * Daemon-side MCP ping supervisor. Lifecycled with the child: instantiated
   * at `spawnGroup`, armed once the child answers its first request, stopped
   * in `teardownGroup`. `null` when the supervisor is disabled via
   * `childPingMs <= 0`.
   */
  childPing: ChildPing | null;
  teardown: Promise<void> | null;
}

type TeardownReason = KilledReason | "shutdown";

type InflightFailure = { kind: "closed"; message: string } | { kind: "restarted"; reason: UpstreamRestartedReason };

type StopReport = Required<Pick<SessionEvictedParams, "exit" | "stderr">>;

export interface SessionAttachment {
  sessionId: string;
  channel: FrameChannel;
  group: ChildGroup;
  startedAt: number;
  receivesStderr: boolean;
}

export interface ManagerOptions {
  socketPath: string;
  pidPath: string;
  lockPath: string;
  /** Daemon self-exits after `idleMs` of having no children/sessions. */
  idleMs: number;
  publicationCheckMs?: number;
  /** Idle-child grace before kill is dispatched. Default 60_000ms. */
  graceMs?: number;
  /** SIGTERM→SIGKILL window. Default 2_000ms. */
  killGraceMs?: number;
  /** Cadence between daemon-side child pings. `0` disables. Default 15_000. */
  childPingMs?: number;
  /** Per-ping deadline. Default 5_000. */
  childPingTimeoutMs?: number;
  /** Wedge threshold: kill the child after N consecutive ping failures. Default 3. */
  childPingMaxConsecutiveFailures?: number;
  transport: Transport;
  /** Keep retrying `start()` while another daemon holds the lock or socket, up to this long. Default 0. */
  awaitPredecessorMs?: number;
  /** Called once, the first time `start()` waits for the daemon it replaces to release the lock or socket. */
  onWaitingForPredecessor?: () => void;
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
   * Optional override for the process tracker file path. Defaults to
   * `processes.json` next to the lock file, which for the real daemon is the
   * run dir (`~/.crabeye/run/processes.json` or its Windows equivalent).
   */
  processTrackerPath?: string;
  /** Pre-built tracker, used by tests to inject fakes. */
  processTracker?: ProcessTracker;
  /** Override for tests: how long a child's close is held back waiting for its exit and the end of its stderr. */
  _stderrDrainMs?: number;
  /** Override for tests: skip real spawn. */
  _spawnChild?: (
    spec: OpenParams["spec"],
    callbacks: {
      onMessage: (payload: unknown) => void;
      onClose: (exit: ProcessExit) => void;
      onError: (err: Error) => void;
      onStderr: (line: string) => void;
    },
  ) => ChildHandle;
}

/**
 * Manager daemon. Owns the lockfile, pidfile, IPC server, and the spawned
 * STDIO upstream children. Sessions with the same `upstreamHash` share a
 * single child.
 */
export class ManagerDaemon {
  private server: DaemonServer | null = null;
  private lock: LockHandle | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private publicationTimer: NodeJS.Timeout | null = null;
  private ready = false;
  private readonly pendingChannels = new Set<FrameChannel>();
  private markReady: () => void = () => {};
  private readonly readyPromise = new Promise<void>((resolve) => {
    this.markReady = () => {
      this.ready = true;
      resolve();
    };
  });
  private connections = new Set<FrameChannel>();
  private groups = new Map<string, ChildGroup>();
  private readonly pendingTeardowns = new Set<Promise<void>>();
  private groupsByHash = new Map<string, ChildGroup>();
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
  private readonly childPingMs: number;
  private readonly childPingTimeoutMs: number;
  private readonly childPingMaxConsecutiveFailures: number;
  private readonly logger: Logger;
  private readonly tracker: ProcessTracker;
  private readonly telemetry = new Telemetry();
  private readonly exitedPromise: Promise<number>;
  private exitedResolve: (code: number) => void = () => {
    /* replaced in constructor */
  };

  private reportedWaitingForPredecessor = false;

  constructor(private readonly opts: ManagerOptions) {
    this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxSessionsPerChannel = opts.maxSessionsPerChannel ?? DEFAULT_MAX_SESSIONS_PER_CHANNEL;
    this.maxSessionsTotal = opts.maxSessionsTotal ?? DEFAULT_MAX_SESSIONS_TOTAL;
    this.graceMs = opts.graceMs ?? 60_000;
    this.killGraceMsValue = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.childPingMs = opts.childPingMs ?? 15_000;
    this.childPingTimeoutMs = opts.childPingTimeoutMs ?? 5_000;
    this.childPingMaxConsecutiveFailures = opts.childPingMaxConsecutiveFailures ?? 3;
    this.logger = opts.logger ?? createNoopLogger();
    this.tracker =
      opts.processTracker ??
      new ProcessTracker({
        filePath: opts.processTrackerPath ?? processTrackerPathFor(opts.lockPath),
        logger: this.logger.child({ component: "process-tracker" }),
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
   * Acquires the lock and claims the IPC socket, then reaps children leaked
   * by a dead previous daemon and writes the pidfile before serving
   * connections (early ones are held until then). Throws `LockBusyError` when
   * another daemon holds the lock and `DaemonAlreadyRunningError` when
   * another daemon owns the socket; in both cases the pidfile, process
   * tracker and live socket are left alone. With `awaitPredecessorMs`,
   * retries until that daemon is gone or the wait runs out.
   */
  async start(): Promise<void> {
    const deadline = Date.now() + (this.opts.awaitPredecessorMs ?? 0);
    for (;;) {
      try {
        return await this.startOnce();
      } catch (err) {
        const heldByPredecessor = err instanceof LockBusyError || err instanceof DaemonAlreadyRunningError;
        if (!heldByPredecessor || Date.now() >= deadline) throw err;
        this.reportWaitingForPredecessor();
        await this.waitBeforeRetryingStart(err instanceof LockBusyError ? err.heldByPid : null, deadline);
      }
    }
  }

  private reportWaitingForPredecessor(): void {
    if (this.reportedWaitingForPredecessor) return;
    this.reportedWaitingForPredecessor = true;
    this.opts.onWaitingForPredecessor?.();
  }

  private async waitBeforeRetryingStart(lockHolder: number | null, deadline: number): Promise<void> {
    await delay(PREDECESSOR_POLL_MS);
    if (lockHolder === null) return;
    const recheckAt = Math.min(deadline, Date.now() + PREDECESSOR_RECHECK_MS);
    while (
      Date.now() < recheckAt &&
      processExists(lockHolder) &&
      (await readLockHolderPid(this.opts.lockPath)) === lockHolder
    ) {
      await delay(PREDECESSOR_POLL_MS);
    }
  }

  private async startOnce(): Promise<void> {
    await this.prepRunDir();

    this.lock = await acquireLock(this.opts.lockPath, {
      pid: this.opts.pid ?? process.pid,
      isForeignProcess,
      track: true,
    });

    try {
      await this.claimSocket();
      await sweepAbandonedLockFiles(this.opts.lockPath);
      await this.reapLeakedChildren();
      await writePidfile(this.opts.pidPath, this.opts.pid ?? process.pid);
      this.startedAt = Date.now();
      this.markReady();
      this.armIdleTimer();
      this.watchPublication();
    } catch (err) {
      this.closePendingChannels();
      await this.server?.stop().catch(() => {});
      this.server = null;
      await this.releaseLock();
      throw err;
    }
  }

  private async claimSocket(): Promise<void> {
    this.server = this.opts.transport.createServer({
      path: this.opts.socketPath,
      onConnection: (channel) => this.acceptWhenReady(channel),
    });
    try {
      await this.server.start();
    } catch (err) {
      this.server = null;
      if (err instanceof SocketInUseError) throw new DaemonAlreadyRunningError(this.opts.socketPath);
      throw err;
    }
  }

  private async reapLeakedChildren(): Promise<void> {
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
  }

  private acceptWhenReady(channel: FrameChannel): void {
    if (this.ready) {
      this.handleConnection(channel);
      return;
    }
    if (this.pendingChannels.size >= this.maxConnections) {
      channel.close();
      return;
    }
    const early: unknown[] = [];
    const hold = (msg: unknown): void => {
      if (early.length >= MAX_EARLY_MESSAGES) {
        this.pendingChannels.delete(channel);
        channel.close();
        return;
      }
      early.push(msg);
    };
    const ignoreError = (): void => {};
    this.pendingChannels.add(channel);
    channel.on("message", hold);
    channel.on("error", ignoreError);
    channel.once("close", () => this.pendingChannels.delete(channel));
    void this.readyPromise.then(() => {
      channel.off("message", hold);
      channel.off("error", ignoreError);
      if (!this.pendingChannels.delete(channel)) return;
      this.handleConnection(channel);
      for (const msg of early) channel.emit("message", msg);
    });
  }

  private closePendingChannels(): void {
    for (const channel of this.pendingChannels) channel.close();
    this.pendingChannels.clear();
  }

  private watchPublication(): void {
    this.publicationTimer = setInterval(
      () => void this.stepDownIfOrphaned(),
      this.opts.publicationCheckMs ?? PUBLICATION_CHECK_MS,
    );
    this.publicationTimer.unref();
  }

  private async stepDownIfOrphaned(): Promise<void> {
    if (this.stopping || this.server === null || (await this.server.isPublished())) return;
    this.logger.warn("another daemon owns the socket now; shutting down", { component: "daemon" });
    await this.stop(0);
  }

  /** Trigger graceful shutdown. Idempotent. */
  async stop(exitCode = 0): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.publicationTimer !== null) {
      clearInterval(this.publicationTimer);
      this.publicationTimer = null;
    }

    // Tear down all sessions before dropping connections so children get
    // a clean kill and the tracker is up-to-date.
    const sessionIds = Array.from(this.sessions.keys());
    for (const sid of sessionIds) {
      await this.detachSession(sid, { kind: "closed", message: "daemon shutdown" }).catch(() => {});
    }
    await Promise.allSettled(Array.from(this.groups.values(), (g) => this.teardownGroup(g, "shutdown")));
    while (this.pendingTeardowns.size > 0) {
      await Promise.allSettled(Array.from(this.pendingTeardowns));
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
      if (await this.lock?.isHeld()) await unlink(this.opts.pidPath);
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
          minBridgeProtocolVersion: MIN_BRIDGE_PROTOCOL_VERSION,
          appVersion: APP_VERSION,
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
        const result: PingResult = { seq: params.seq, pid: this.opts.pid ?? process.pid };
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
          void this.detachSession(sid, { kind: "closed", message: "session closed" }).catch(() => {
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
                ...(typeof initResult.instructions === "string" && {
                  instructions: initResult.instructions,
                }),
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
    if (this.stopping) {
      return errorResponse(requestId, ERROR_CODE_DAEMON_STOPPING, "manager is shutting down");
    }
    const params = parseOpenParams(rawParams);
    if (params === null) {
      return errorResponse(requestId, ERROR_CODE_INVALID_PARAMS, "OPEN params malformed");
    }
    const bridgeProtocolVersion = params.bridgeProtocolVersion ?? UNREPORTED_BRIDGE_PROTOCOL_VERSION;
    if (bridgeProtocolVersion < MIN_BRIDGE_PROTOCOL_VERSION) {
      return errorResponse(
        requestId,
        ERROR_CODE_BRIDGE_UNSUPPORTED,
        `this daemon needs a bridge using protocol version ${MIN_BRIDGE_PROTOCOL_VERSION} or newer, not ${bridgeProtocolVersion}; restart the assistant to use the current ${APP_NAME}`,
      );
    }
    if (this.sessions.has(params.sessionId)) {
      return errorResponse(requestId, ERROR_CODE_SESSION_IN_USE, "sessionId already in use");
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

    let group: ChildGroup;

    const existing = this.liveGroupFor(hash);
    if (existing !== undefined) {
      group = existing;
      this.cancelGraceTimer(group);
    } else {
      const spawned = this.spawnGroup(hash, params.spec);
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
      receivesStderr: bridgeProtocolVersion >= STDERR_BRIDGE_PROTOCOL_VERSION,
    };
    this.sessions.set(params.sessionId, attachment);
    this.telemetry.recordSessionOpen();
    const owned = this.sessionsByChannel.get(channel) ?? new Set<string>();
    owned.add(params.sessionId);
    this.sessionsByChannel.set(channel, owned);
    this.cancelIdleTimer();

    return { id: requestId, result: { ok: true } };
  }

  private liveGroupFor(hash: string): ChildGroup | undefined {
    const group = this.groupsByHash.get(hash);
    if (group === undefined || group.teardown !== null || !group.child.alive) return undefined;
    return group;
  }

  private spawnGroup(hash: string, spec: OpenParams["spec"]): ChildGroup | Error {
    const rewriter = new TokenRewriter();
    const subscriptions = new SubscriptionTracker();
    const router = new NotificationRouter();
    const groupRef: { value: ChildGroup | null } = { value: null };
    const stderrLimit = new StderrForwardLimit((line) => {
      const g = groupRef.value;
      if (g !== null) this.forwardStderr(g, line);
    });

    const callbacks = {
      onMessage: (payload: unknown): void => {
        const g = groupRef.value;
        if (g !== null) this.routeChildMessage(g, payload);
      },
      onClose: (exit: ProcessExit): void => {
        const g = groupRef.value;
        if (g !== null) void this.teardownGroup(g, "crash", exit);
      },
      onError: (err: Error): void => {
        this.logger.warn(`child error: ${err.message}`, { component: "daemon", upstreamHash: hash });
      },
      onStderr: (line: string): void => stderrLimit.offer(line),
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
            stderrDrainMs: this.opts._stderrDrainMs,
            ...callbacks,
          });
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }

    const group: ChildGroup = {
      groupId: `${hash}:${this.nextGroupCounter++}`,
      upstreamHash: hash,
      child,
      rewriter,
      subscriptions,
      router,
      stderrLimit,
      sessions: new Set(),
      serverName: spec.serverName,
      startedAt: child.startedAt,
      graceTimer: null,
      teardown: null,
      initializedSeen: false,
      internalRequests: new Map(),
      nextInternalId: -1,
      childPing: null,
    };
    groupRef.value = group;

    if (this.childPingMs > 0) {
      group.childPing = new ChildPing({
        pingMs: this.childPingMs,
        timeoutMs: this.childPingTimeoutMs,
        maxConsecutiveFailures: this.childPingMaxConsecutiveFailures,
        logger: this.logger.child({
          component: "child-ping",
          upstreamHash: hash,
          server: spec.serverName,
        }),
        deps: {
          allocateId: () => {
            const id = group.nextInternalId;
            group.nextInternalId -= 1;
            return id;
          },
          registerCallback: (id, cb) => {
            // ChildPing only cares whether a response landed, not what it
            // contained. Wrap to match the manager's payload-receiving
            // callback shape.
            group.internalRequests.set(id, () => cb());
          },
          unregisterCallback: (id) => {
            group.internalRequests.delete(id);
          },
          sendPayload: (payload) => {
            group.child.send(payload);
          },
          onWedged: (reason) => {
            if (!group.child.alive) return;
            this.logger.error(
              `child wedged: ${reason} — killing`,
              {
                component: "child-ping",
                upstreamHash: hash,
                server: spec.serverName,
                pid: group.child.pid,
              },
            );
            void this.teardownGroup(group, "wedged", { cause: "unresponsive", code: null, signal: null });
          },
        },
      });
    }

    this.groupsByHash.set(hash, group);

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
    await this.detachSession(params.sessionId, { kind: "closed", message: "session closed" });
    return { id: requestId, result: { ok: true } };
  }

  /** Admin RESTART: kill the child group(s) matching `params.upstreamHash`. */
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
    const matched = Array.from(this.groups.values()).filter(
      (g) => g.upstreamHash === hash,
    );
    for (const group of matched) {
      void this.teardownGroup(group, "restart");
    }
    const result: RestartResult = { ok: true, killed: matched.length };
    return { id: reqId, result };
  }

  /**
   * Route an inbound child→bridge message to the correct session(s).
   * - "response" / "progress" / "cancelled": sessionIds from rewriter (originating session)
   * - "internal": a reply to a request the daemon sent itself (its own pings), handed to its callback
   * - "drop": silently discard
   * - "other": a request from the child is answered by the daemon (child-requests.ts); a notification is
   *   fanned out by NotificationRouter
   */
  private routeChildMessage(group: ChildGroup, payload: unknown): void {
    const routing = group.rewriter.inboundFromChild(payload);
    if (routing.kind === "response" || routing.kind === "internal") group.childPing?.start();
    if (routing.kind === "drop") return;
    if (routing.kind === "response") {
      // Capture cachedInit from the first initialize response.
      // Heuristic: any first response with protocolVersion+serverInfo+capabilities triple is treated as the
      // initialize result. This is safe because initialize is the only request-with-result of this shape
      // sent before any other traffic in the MCP protocol. False-positive risk is negligible.
      if (group.child.cachedInit === null) {
        const restored = routing.payload as { id?: unknown; result?: unknown };
        const result = restored.result as
          | {
              protocolVersion?: unknown;
              serverInfo?: unknown;
              capabilities?: unknown;
              instructions?: unknown;
            }
          | undefined;
        if (
          result !== undefined &&
          typeof result.protocolVersion === "string" &&
          typeof result.serverInfo === "object" &&
          result.serverInfo !== null &&
          typeof result.capabilities === "object" &&
          result.capabilities !== null
        ) {
          // Cap cached `instructions` to defend the daemon's RSS against a
          // hostile upstream that returns a multi-MiB string. The bridge has
          // its own per-server cap on top; this is a backstop.
          const DAEMON_INSTRUCTIONS_CAP = 64 * 1024;
          const rawInstr = result.instructions;
          const instrToCache =
            typeof rawInstr === "string" && rawInstr.length > 0
              ? rawInstr.slice(0, DAEMON_INSTRUCTIONS_CAP)
              : undefined;
          group.child.setCachedInit({
            protocolVersion: result.protocolVersion,
            serverInfo: result.serverInfo as CachedInit["serverInfo"],
            capabilities: result.capabilities as Record<string, unknown>,
            ...(instrToCache !== undefined && { instructions: instrToCache }),
          });
        }
      }
      this.deliver(group, routing.sessionIds, routing.payload);
      return;
    }
    if (routing.kind === "progress" || routing.kind === "cancelled") {
      this.deliver(group, routing.sessionIds, routing.payload);
      return;
    }
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
    if (isChildRequest(routing.payload)) {
      this.replyToChildRequest(group, routing.payload);
      return;
    }
    const sessions = group.router.route(routing.payload, Array.from(group.sessions), group.subscriptions);
    if (sessions.length > 0) this.deliver(group, sessions, routing.payload);
  }

  private replyToChildRequest(group: ChildGroup, request: ChildRequest): void {
    const label = methodLabel(request.method);
    if (request.method !== "ping") this.telemetry.recordRefusedUpstreamRequest(label);
    try {
      group.child.send(answerChildRequest(request, label));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`could not answer child request "${label}": ${reason}`, {
        component: "daemon",
        upstreamHash: group.upstreamHash,
      });
    }
  }

  private deliver(group: ChildGroup, sessionIds: string[], payload: unknown): void {
    for (const sid of sessionIds) {
      const att = this.sessions.get(sid);
      if (att === undefined) continue;
      const ok = att.channel.send({ method: "RPC", params: { sessionId: sid, payload } });
      if (!ok) {
        this.logger.debug("RPC notification not sent", {
          component: "daemon",
          sessionId: sid,
          upstreamHash: group.upstreamHash,
        });
      }
    }
  }

  private teardownGroup(group: ChildGroup, reason: TeardownReason, exit?: ChildExit): Promise<void> {
    if (group.teardown !== null) return group.teardown;
    const teardown: Promise<void> = Promise.resolve()
      .then(() => this.runTeardown(group, reason, exit))
      .catch((err: unknown) => {
        this.logger.error(`child teardown failed: ${err instanceof Error ? err.message : String(err)}`, {
          groupId: group.groupId,
        });
      })
      .finally(() => {
        this.pendingTeardowns.delete(teardown);
      });
    group.teardown = teardown;
    this.pendingTeardowns.add(teardown);
    return teardown;
  }

  private async runTeardown(group: ChildGroup, reason: TeardownReason, exit?: ChildExit): Promise<void> {
    try {
      if (this.groups.get(group.groupId) === group) {
        this.groups.delete(group.groupId);
        if (reason !== "shutdown") this.telemetry.recordKill(reason);
      }
      if (this.groupsByHash.get(group.upstreamHash) === group) this.groupsByHash.delete(group.upstreamHash);
      this.cancelGraceTimer(group);
      group.childPing?.stop();
      group.stderrLimit.stop();
      if (reason !== "shutdown") this.evictSessionsOf(group, reason, exit);
    } finally {
      const pid = group.child.pid;
      await group.child.kill(this.killGraceMs()).catch(() => {});
      if (pid !== null) await this.tracker.unregister(pid).catch(() => {});
    }
    if (this.connections.size === 0 && this.sessions.size === 0 && this.groups.size === 0 && !this.stopping) {
      this.armIdleTimer();
    }
  }

  private evictSessionsOf(group: ChildGroup, reason: KilledReason, exit?: ChildExit): void {
    const [evictionReason, inflightFailure]: [SessionEvictedParams["reason"], InflightFailure] =
      reason === "restart"
        ? ["upstream_restarted", { kind: "restarted", reason: "admin_restart" }]
        : ["child_exited", { kind: "closed", message: "child process exited" }];
    const stop: StopReport | undefined = exit && { exit, stderr: group.child.stderrTail() };
    for (const att of Array.from(this.sessions.values())) {
      if (att.group === group) this.evictSession(att.sessionId, evictionReason, inflightFailure, stop);
    }
  }

  private sendInflightFailure(
    channel: FrameChannel,
    sessionId: string,
    innerId: InnerId,
    inflightFailure: InflightFailure,
  ): void {
    if (inflightFailure.kind === "restarted") {
      this.sendUpstreamRestartedError(channel, sessionId, innerId, inflightFailure.reason);
    } else {
      this.sendInnerError(channel, sessionId, innerId, INNER_ERROR_CODE_SESSION_CLOSED, inflightFailure.message);
    }
  }

  private evictSession(
    sessionId: string,
    reason: SessionEvictedParams["reason"],
    inflightFailure: InflightFailure,
    stop?: StopReport,
  ): void {
    const att = this.sessions.get(sessionId);
    if (att === undefined) return;
    void this.detachSession(sessionId, inflightFailure).catch(() => {});
    const params: SessionEvictedParams = { sessionId, reason, ...(att.receivesStderr && stop) };
    att.channel.send({ method: "SESSION_EVICTED", params });
  }

  private forwardStderr(group: ChildGroup, line: string): void {
    for (const sessionId of group.sessions) {
      const att = this.sessions.get(sessionId);
      if (att?.receivesStderr) att.channel.send({ method: "STDERR", params: { sessionId, line } satisfies StderrParams });
    }
  }

  /**
   * Detach a session from its group. Fails its in-flight requests with
   * `inflightFailure`, decrements refcount, arms the grace timer at 0. Does NOT kill
   * the child unless the grace timer expires.
   */
  private async detachSession(sessionId: string, inflightFailure: InflightFailure): Promise<void> {
    const att = this.sessions.get(sessionId);
    if (att === undefined) return;

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
      this.sendInflightFailure(att.channel, sessionId, innerId, inflightFailure);
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
    if (group.teardown !== null || this.stopping) return;
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
    group.graceTimer = null;
    await this.teardownGroup(group, "grace");
  }

  private cancelGraceTimer(group: ChildGroup): void {
    if (group.graceTimer !== null) {
      clearTimeout(group.graceTimer);
      group.graceTimer = null;
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

function isProtocolVersionNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function parseOpenParams(raw: unknown): OpenParams | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { sessionId?: unknown; bridgeProtocolVersion?: unknown; spec?: unknown };
  if (typeof r.sessionId !== "string" || !UUID_RE.test(r.sessionId)) return null;
  if (r.sessionId.length > MAX_SESSION_ID_BYTES) return null;
  const { bridgeProtocolVersion } = r;
  if (bridgeProtocolVersion !== undefined && !isProtocolVersionNumber(bridgeProtocolVersion)) return null;
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
    ...(bridgeProtocolVersion !== undefined && { bridgeProtocolVersion }),
    spec: {
      serverName: s.serverName,
      command: s.command,
      args: s.args as string[],
      resolvedEnv: s.resolvedEnv as Record<string, string>,
      cwd: s.cwd,
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
 * still wins on key collision for non-denied keys, except the upstream marker,
 * which is always this daemon's pid.
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
  out[UPSTREAM_MARKER_ENV] = String(process.pid);
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

export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly socketPath: string) {
    super(`a daemon is already serving ${socketPath}`);
    this.name = "DaemonAlreadyRunningError";
  }
}
