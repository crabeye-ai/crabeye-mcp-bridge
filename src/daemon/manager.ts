import { open, lstat, mkdir, chmod, unlink } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createNoopLogger, type Logger } from "../logging/index.js";
import { upstreamHash } from "../upstream/upstream-hash.js";
import { acquireLock, LockBusyError, type LockHandle } from "./lockfile.js";
import { ChildHandle, BackpressureError } from "./child-handle.js";
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
  type RpcNotificationParams,
  type StatusChild,
  type StatusResult,
  type StatusSession,
} from "./protocol.js";
import { InflightOverflowError, TokenRewriter, type InnerId } from "./token-rewriter.js";
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

interface SessionState {
  sessionId: string;
  channel: FrameChannel;
  child: ChildHandle;
  rewriter: TokenRewriter;
  serverName: string;
  upstreamHash: string;
  startedAt: number;
}

export interface ManagerOptions {
  socketPath: string;
  pidPath: string;
  lockPath: string;
  /** Daemon self-exits after `idleMs` of having no children/sessions. */
  idleMs: number;
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
 * Phase-B manager daemon. Owns the lockfile, pidfile, IPC server, and the
 * spawned STDIO upstream children. Sessions map 1:1 to children in this
 * phase; phase C will dedupe by `upstreamHash` so multiple sessions share.
 */
export class ManagerDaemon {
  private server: DaemonServer | null = null;
  private lock: LockHandle | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private connections = new Set<FrameChannel>();
  private sessions = new Map<string, SessionState>();
  private sessionsByChannel = new Map<FrameChannel, Set<string>>();
  private startedAt = 0;
  private stopping = false;
  private exited = false;
  private readonly maxConnections: number;
  private readonly maxSessionsPerChannel: number;
  private readonly maxSessionsTotal: number;
  private readonly logger: Logger;
  private readonly tracker: ProcessTracker;
  private readonly exitedPromise: Promise<number>;
  private exitedResolve: (code: number) => void = () => {
    /* replaced in constructor */
  };

  constructor(private readonly opts: ManagerOptions) {
    this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.maxSessionsPerChannel = opts.maxSessionsPerChannel ?? DEFAULT_MAX_SESSIONS_PER_CHANNEL;
    this.maxSessionsTotal = opts.maxSessionsTotal ?? DEFAULT_MAX_SESSIONS_TOTAL;
    this.logger = opts.logger ?? createNoopLogger();
    this.tracker =
      opts.processTracker ??
      new ProcessTracker({
        filePath: opts.processTrackerPath ?? getProcessTrackerPath(),
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
      await this.closeSession(sid, "session closed").catch(() => {
        /* swallow during shutdown */
      });
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
      case "OPENED":
      case "RESTART":
        return errorResponse(
          req.id,
          "not_implemented",
          `method "${req.method}" is not implemented in this phase`,
        );
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
          // Channel died: emit synthetic errors and reap.
          void this.closeSession(sid, "session closed").catch(() => {
            /* logged inside */
          });
        }
      }
      if (this.connections.size === 0 && this.sessions.size === 0 && !this.stopping) {
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
      const res = await this.handleRequest(msg, channel);
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
    const session = this.sessions.get(params.sessionId);
    if (session === undefined || session.channel !== channel) {
      // Cross-channel session access is never legal in B; silently drop to
      // avoid leaking session existence.
      this.logger.debug("RPC for unknown session", {
        component: "daemon",
        sessionId: params.sessionId,
      });
      return;
    }
    let rewritten: unknown;
    try {
      rewritten = session.rewriter.outboundForChild(params.payload, session.sessionId);
    } catch (err) {
      if (err instanceof InflightOverflowError) {
        const innerId = pickInnerId(params.payload);
        if (innerId !== null) {
          this.sendInnerError(channel, session.sessionId, innerId, INNER_ERROR_CODE_BACKPRESSURE, err.message);
        }
        return;
      }
      throw err;
    }
    // Capture the outer id allocated by outboundForChild so we can remove it
    // from inflight tracking if the child stdin write fails (Phase C: outer id
    // is a fresh integer, not the original inner id).
    const allocatedOuterId = (rewritten as { id?: unknown })?.id;
    try {
      session.child.send(rewritten);
    } catch (err) {
      if (err instanceof BackpressureError) {
        const innerId = pickInnerId(params.payload);
        if (innerId !== null) {
          // The outer id was added to inflight tracking by outboundForChild but
          // the child never received it — pop it so the tracking Set doesn't
          // leak it forever.
          if (typeof allocatedOuterId === "number") {
            session.rewriter.removeInflight(session.sessionId, allocatedOuterId);
          }
          this.sendInnerError(channel, session.sessionId, innerId, INNER_ERROR_CODE_BACKPRESSURE, err.message);
        }
        return;
      }
      this.logger.warn(
        `child stdin write failed: ${err instanceof Error ? err.message : String(err)}`,
        { component: "daemon", sessionId: session.sessionId },
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

    const rewriter = new TokenRewriter();
    rewriter.attachSession(params.sessionId);

    const sessionLogger = this.logger.child({
      component: "daemon",
      server: params.spec.serverName,
      sessionId: params.sessionId,
    });

    let child: ChildHandle;
    try {
      const callbacks = {
        onMessage: (payload: unknown): void => {
          this.routeChildMessage(params.sessionId, rewriter, payload);
        },
        onClose: (): void => {
          this.handleChildExit(params.sessionId);
        },
        onError: (err: Error): void => {
          sessionLogger.warn(`child error: ${err.message}`);
        },
        onStderr: (line: string): void => {
          sessionLogger.debug(line, { stream: "stderr" });
        },
      };

      child = this.opts._spawnChild
        ? this.opts._spawnChild(params.spec, callbacks)
        : new ChildHandle({
            command: params.spec.command,
            args: params.spec.args,
            env: buildSpawnEnv(params.spec.resolvedEnv),
            cwd: params.spec.cwd === "" ? undefined : params.spec.cwd,
            ...callbacks,
          });
    } catch (err) {
      return errorResponse(
        requestId,
        ERROR_CODE_SPAWN_FAILED,
        err instanceof Error ? err.message : String(err),
      );
    }

    const state: SessionState = {
      sessionId: params.sessionId,
      channel,
      child,
      rewriter,
      serverName: params.spec.serverName,
      upstreamHash: hash,
      startedAt: child.startedAt,
    };
    this.sessions.set(params.sessionId, state);
    const owned = this.sessionsByChannel.get(channel) ?? new Set<string>();
    owned.add(params.sessionId);
    this.sessionsByChannel.set(channel, owned);
    this.cancelIdleTimer();

    if (child.pid !== null) {
      try {
        await this.tracker.register({
          pid: child.pid,
          command: params.spec.command,
          args: params.spec.args,
          server: params.spec.serverName,
          startedAt: child.startedAt,
        });
      } catch (err) {
        this.logger.warn(`failed to record spawned subprocess: ${err instanceof Error ? err.message : String(err)}`, {
          component: "daemon",
          sessionId: params.sessionId,
          pid: child.pid,
        });
      }
    }

    return { id: requestId, result: { ok: true } };
  }

  private async handleClose(requestId: string, rawParams: unknown): Promise<DaemonResponse> {
    const params = parseCloseParams(rawParams);
    if (params === null) {
      return errorResponse(requestId, ERROR_CODE_INVALID_PARAMS, "CLOSE params malformed");
    }
    const session = this.sessions.get(params.sessionId);
    if (session === undefined) {
      return errorResponse(requestId, ERROR_CODE_SESSION_NOT_FOUND, "no such session");
    }
    await this.closeSession(params.sessionId, "session closed");
    return { id: requestId, result: { ok: true } };
  }

  /**
   * Route an inbound child→bridge message to its session(s). For phase B
   * this is always the single session attached to the child.
   *
   * Phase C routing:
   * - "response": sessionIds resolved from outer-id map; payload has original
   *   id restored. Deliver to the single resolved session.
   * - "other": notifications and other unrecognised frames — broadcast to the
   *   owning session (phase B: 1:1; phase C Task 6 replaces this with the
   *   NotificationRouter fan-out).
   * - "drop": no mapping found; silently discard.
   */
  private routeChildMessage(sessionId: string, rewriter: TokenRewriter, payload: unknown): void {
    const routing = rewriter.inboundFromChild(payload);
    const targetIds = routing.kind === "other" ? [sessionId] : routing.sessionIds;
    for (const sid of targetIds) {
      const session = this.sessions.get(sid);
      if (session === undefined) continue;
      const ok = session.channel.send({
        method: "RPC",
        params: { sessionId: sid, payload: routing.payload },
      });
      if (!ok) {
        this.logger.debug("RPC notification dropped (backpressure)", {
          component: "daemon",
          sessionId,
        });
      }
    }
  }

  private handleChildExit(sessionId: string): void {
    // Child died on its own (crash, exit). Run synthetic-error cleanup and
    // drop session state. The bridge will see the channel still open but
    // its in-flight requests resolve with `session closed`.
    void this.closeSession(sessionId, "child process exited").catch(() => {
      /* logged inside */
    });
  }

  /**
   * Close a session: emit synthetic JSON-RPC error responses for any
   * in-flight inner request `id`s, kill the child, unregister from the
   * process tracker, and drop the session state.
   */
  private async closeSession(sessionId: string, reason: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);

    const owned = this.sessionsByChannel.get(session.channel);
    if (owned) {
      owned.delete(sessionId);
    }

    // Synthetic errors first so the bridge MCP client clears its pending
    // promises before the channel maybe goes away.
    // Resolve original inner ids BEFORE detachSession (which clears the origin map),
    // then send errors AFTER detach so the rewriter state is clean before any callbacks fire.
    const inflightOuters = session.rewriter.inflightForSession(sessionId);
    const originals: InnerId[] = [];
    for (const outerId of inflightOuters) {
      const origin = session.rewriter.peekOrigin(outerId);
      if (origin !== undefined) originals.push(origin.originalId);
    }
    session.rewriter.detachSession(sessionId);
    for (const innerId of originals) {
      this.sendInnerError(session.channel, sessionId, innerId, INNER_ERROR_CODE_SESSION_CLOSED, reason);
    }

    const pid = session.child.pid;
    try {
      await session.child.kill();
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

    if (this.connections.size === 0 && this.sessions.size === 0 && !this.stopping) {
      this.armIdleTimer();
    }
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

  private statusChildren(): StatusChild[] {
    const seen = new Map<string, StatusChild>();
    for (const session of this.sessions.values()) {
      const pid = session.child.pid;
      if (pid === null) continue;
      seen.set(`${pid}`, {
        pid,
        upstreamHash: session.upstreamHash,
        startedAt: session.startedAt,
      });
    }
    return Array.from(seen.values());
  }

  private statusSessions(): StatusSession[] {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      upstreamHash: s.upstreamHash,
      serverName: s.serverName,
    }));
  }

  private armIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.stopping && this.connections.size === 0 && this.sessions.size === 0) {
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
  return {
    sessionId: r.sessionId,
    spec: {
      serverName: s.serverName,
      command: s.command,
      args: s.args as string[],
      resolvedEnv: s.resolvedEnv as Record<string, string>,
      cwd: s.cwd,
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
