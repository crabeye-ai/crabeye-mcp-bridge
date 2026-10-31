import { unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { APP_NAME, APP_VERSION, DEFAULT_KILL_GRACE_MS } from "../constants.js";
import { createNoopLogger, type Logger } from "../logging/index.js";
import {
  acquireLock,
  LockBusyError,
  readLockHolderPid,
  sweepAbandonedLockFiles,
  type LockHandle,
} from "../process/lockfile.js";
import { processExists } from "../process/process-utils.js";
import { ensurePrivateDir } from "../process/private-dir.js";
import { isForeignProcess } from "./daemon-identity.js";
import { readPidFile, writePidFile } from "./pidfile.js";
import { ProcessTracker } from "./process-tracker.js";
import { processTrackerPathFor } from "./paths.js";
import {
  ERROR_CODE_INVALID_PARAMS,
  ERROR_CODE_INVALID_REQUEST,
  ERROR_CODE_TOO_MANY_CONNECTIONS,
  ERROR_CODE_BRIDGE_UNSUPPORTED,
  ERROR_CODE_UNKNOWN_METHOD,
  ERROR_CODE_RESPONSE_TOO_LARGE,
  MIN_BRIDGE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  errorResponse,
  isNotification,
  isRequest,
  type DaemonError,
  type DaemonNotification,
  type DaemonRequest,
  type DaemonResponse,
  type PingParams,
  type PingResult,
  type RestartParams,
  type RestartResult,
  type StatusResult,
} from "./protocol.js";
import { RateLimitedReport } from "./rate-limited-report.js";
import { Telemetry } from "./telemetry.js";
import { SocketInUseError, type DaemonServer, type FrameChannel, type Transport } from "./transport.js";
import type { SpawnChild } from "./instances/child-transport.js";
import { InstanceHost, type InstanceHostOptions } from "./instances/instance-host.js";

const PUBLICATION_CHECK_MS = 5_000;
const REFUSED_SESSIONS_REPORT_INTERVAL_MS = 60_000;
const SESSION_REFUSAL = `this manager runs ${APP_NAME} ${APP_VERSION}; restart the AI client to use it`;
const PREDECESSOR_POLL_MS = 25;
const PREDECESSOR_RECHECK_MS = 1_000;
const MAX_EARLY_MESSAGES = 64;

/** Bound on simultaneous IPC clients. Same-UID DoS hardening. */
const DEFAULT_MAX_CONNECTIONS = 256;

const PROTOCOL_MISSING_FIELD: DaemonError = {
  code: ERROR_CODE_INVALID_REQUEST,
  message: "request missing required fields { id, method }",
};

export interface ManagerOptions {
  socketPath: string;
  pidPath: string;
  lockPath: string;
  /** Daemon self-exits after `idleMs` with no connections, instances or children. */
  idleMs: number;
  publicationCheckMs?: number;
  /** How long a STDIO server outlives its last user. Default 60_000ms. */
  graceMs?: number;
  /** SIGTERM→SIGKILL window. Default 2_000ms. */
  killGraceMs?: number;
  /** Cadence between daemon-side child pings. `0` disables. Default 15_000. */
  childPingMs?: number;
  /** Per-ping deadline. Default 5_000. */
  childPingTimeoutMs?: number;
  /** Start the child again after N consecutive ping failures. Default 3. */
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
  /** Overrides for tests: how instances load configs, open credential stores and connect HTTP upstreams. */
  _instances?: Pick<InstanceHostOptions, "loadConfig" | "createCredentialStore" | "createHttpClient" | "watchDebounceMs">;
  /** Override for tests: how STDIO servers are started. */
  _spawnChild?: SpawnChild;
}

/**
 * Manager daemon. Owns the lockfile, pidfile, IPC server, and the instances
 * that connect every upstream, starting each STDIO server once.
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
  private startedAt = 0;
  private stopping = false;
  private exited = false;
  private exitCode = 0;
  private starting: Promise<void> | null = null;
  private readonly maxConnections: number;
  private readonly killGraceMsValue: number;
  private readonly logger: Logger;
  private readonly tracker: ProcessTracker;
  private readonly telemetry = new Telemetry();
  private readonly refusedSessions = new RateLimitedReport<undefined>(REFUSED_SESSIONS_REPORT_INTERVAL_MS, (refused) =>
    this.logger.warn("session refused", { component: "daemon", reason: SESSION_REFUSAL, errorCode: ERROR_CODE_BRIDGE_UNSUPPORTED, refused }),
  );
  private readonly instances: InstanceHost;
  private readonly exitedPromise: Promise<number>;
  private exitedResolve: (code: number) => void = () => {
    /* replaced in constructor */
  };

  private reportedWaitingForPredecessor = false;

  constructor(private readonly opts: ManagerOptions) {
    this.maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
    this.killGraceMsValue = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
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
    this.instances = new InstanceHost({
      idleMs: opts.idleMs,
      logger: this.logger,
      onIdle: () => this.armIdleTimerIfUnused(),
      stdio: {
        graceMs: opts.graceMs ?? 60_000,
        killGraceMs: this.killGraceMsValue,
        stderrDrainMs: opts._stderrDrainMs,
        childPing: {
          intervalMs: opts.childPingMs ?? 15_000,
          timeoutMs: opts.childPingTimeoutMs ?? 5_000,
          maxConsecutiveFailures: opts.childPingMaxConsecutiveFailures ?? 3,
        },
        recorder: this.tracker,
        counters: this.telemetry,
        spawnChild: opts._spawnChild,
      },
      ...opts._instances,
    });
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  private get pid(): number {
    return this.opts.pid ?? process.pid;
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
   * retries until that daemon is gone or the wait runs out. Throws
   * `DaemonStoppedWhileStartingError` when `stop()` is called before it serves.
   */
  start(): Promise<void> {
    this.starting = this.startUntilServing();
    return this.starting;
  }

  private async startUntilServing(): Promise<void> {
    const deadline = Date.now() + (this.opts.awaitPredecessorMs ?? 0);
    for (;;) {
      if (this.stopping) throw new DaemonStoppedWhileStartingError();
      try {
        return await this.startOnce();
      } catch (err) {
        const heldByPredecessor = err instanceof LockBusyError || err instanceof DaemonAlreadyRunningError;
        if (this.stopping && heldByPredecessor) throw new DaemonStoppedWhileStartingError();
        if (!heldByPredecessor || Date.now() >= deadline) throw err;
        const holderPid = err instanceof LockBusyError ? err.heldByPid : null;
        this.reportWaitingForPredecessor(holderPid);
        await this.waitBeforeRetryingStart(holderPid, deadline);
      }
    }
  }

  private reportWaitingForPredecessor(holderPid: number | null): void {
    if (this.reportedWaitingForPredecessor) return;
    this.reportedWaitingForPredecessor = true;
    this.logger.info("waiting for the previous daemon to exit", { component: "daemon", previousPid: holderPid ?? undefined });
    this.opts.onWaitingForPredecessor?.();
  }

  private async waitBeforeRetryingStart(lockHolder: number | null, deadline: number): Promise<void> {
    await delay(PREDECESSOR_POLL_MS);
    if (lockHolder === null) return;
    const recheckAt = Math.min(deadline, Date.now() + PREDECESSOR_RECHECK_MS);
    while (
      !this.stopping &&
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
      pid: this.pid,
      isForeignProcess,
      track: true,
    });

    try {
      await this.claimSocket();
      await sweepAbandonedLockFiles(this.opts.lockPath);
      await this.logPreviousDaemonGone(this.lock.takenOverFrom);
      await this.reapLeakedChildren();
      if (this.stopping) throw new DaemonStoppedWhileStartingError();
      await writePidFile(this.opts.pidPath, this.pid);
      this.startedAt = Date.now();
      this.markReady();
      if (!this.stopping) {
        this.logger.info(this.reportedWaitingForPredecessor ? "previous daemon gone; serving" : "serving", { component: "daemon" });
      }
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

  private async logPreviousDaemonGone(lockHolderPid: number | null): Promise<void> {
    const previousPid = lockHolderPid ?? (await this.deadRecordedPid());
    if (previousPid === null) return;
    this.logger.info("took over from a previous daemon that is no longer running", { component: "daemon", previousPid });
  }

  private async deadRecordedPid(): Promise<number | null> {
    const recorded = await readPidFile(this.opts.pidPath);
    if (recorded === null || recorded === this.pid || processExists(recorded)) return null;
    return recorded;
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
      const reaped = await this.tracker.reapStale(() => this.stopping);
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
      this.logger.warn("connection refused", { component: "daemon", reason: "too many connections while starting" });
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
    await this.stop(0, "another daemon owns the socket");
  }

  /** Trigger graceful shutdown. Idempotent. */
  async stop(exitCode = 0, reason = "stop requested"): Promise<void> {
    this.exitCode = Math.max(this.exitCode, exitCode);
    if (this.stopping) return;
    this.stopping = true;
    this.logger.info("daemon stopping", { component: "daemon", reason });
    await this.starting?.catch(() => {});

    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.publicationTimer !== null) {
      clearInterval(this.publicationTimer);
      this.publicationTimer = null;
    }

    await this.instances.close(this.killGraceMsValue);
    this.refusedSessions.flush();

    for (const ch of this.connections) {
      try {
        ch.close();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();

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
      else if (this.lock !== null) this.logger.warn("lock was lost; leaving the pidfile in place", { component: "daemon" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        const failure = `pidfile cleanup: ${(err as Error).message}`;
        process.stderr.write(`${failure}\n`);
        this.logger.warn(failure, { component: "daemon" });
      }
    }

    await this.releaseLock();

    if (!this.exited) {
      this.exited = true;
      this.logger.info("daemon exited", { component: "daemon", exitCode: this.exitCode });
      this.opts.onExit?.(this.exitCode);
      this.exitedResolve(this.exitCode);
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
          pid: this.pid,
          version: PROTOCOL_VERSION,
          minBridgeProtocolVersion: MIN_BRIDGE_PROTOCOL_VERSION,
          appVersion: APP_VERSION,
          children: this.instances.statusChildren(),
          instances: this.instances.statusInstances(),
          upstreams: this.instances.statusUpstreams(),
          telemetry: this.telemetry.snapshot(),
        };
        return { id: req.id, result };
      }
      case "SHUTDOWN":
        // setImmediate gives the response a chance to drain to the kernel
        // before stop() destroys the connection.
        setImmediate(() => {
          void this.stop(0, "shutdown requested");
        });
        return { id: req.id, result: { ok: true } };
      case "OPEN":
        return this.refuseSession(req.id);
      case "ATTACH":
        if (channel === undefined) return errorResponse(req.id, ERROR_CODE_INVALID_REQUEST, "ATTACH requires a channel");
        return this.instances.handleAttach(req.id, req.params, channel);
      case "CALL_TOOL":
        if (channel === undefined) return errorResponse(req.id, ERROR_CODE_INVALID_REQUEST, "CALL_TOOL requires a channel");
        return this.instances.handleCallTool(req.id, req.params, channel);
      case "RETRY":
        if (channel === undefined) return errorResponse(req.id, ERROR_CODE_INVALID_REQUEST, "RETRY requires a channel");
        return this.instances.handleRetry(req.id, req.params, channel);
      case "RESTART":
        return this.handleRestart(req.id, req.params);
      case "AUTH_CHANGED":
        return this.instances.handleAuthChanged(req.id, req.params);
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
        const result: PingResult = { seq: params.seq, pid: this.pid };
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
      this.logger.warn("connection refused", { component: "daemon", reason: "manager at connection cap" });
      channel.send({
        id: "",
        error: { code: ERROR_CODE_TOO_MANY_CONNECTIONS, message: "manager at connection cap" },
      });
      channel.close();
      return;
    }
    this.connections.add(channel);
    this.cancelIdleTimer();

    channel.on("message", (msg: unknown) => {
      void this.dispatchFrame(channel, msg);
    });

    channel.on("error", () => {
      /* swallow — close handler does the cleanup */
    });

    channel.on("close", () => {
      this.connections.delete(channel);
      this.instances.channelClosed(channel);
      this.armIdleTimerIfUnused();
    });
  }

  private async dispatchFrame(channel: FrameChannel, msg: unknown): Promise<void> {
    if (isNotification(msg)) {
      this.handleNotification(channel, msg);
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
      if (!channel.send(res)) {
        channel.send(errorResponse(res.id, ERROR_CODE_RESPONSE_TOO_LARGE, "the reply is too large for the manager to send"));
      }
      return;
    }
    // Response or malformed — daemon does not initiate requests yet, so a
    // response from the bridge is unexpected. Log and drop.
    this.logger.debug("dropping unexpected frame from peer", { component: "daemon" });
  }

  private handleNotification(channel: FrameChannel, notif: DaemonNotification): void {
    if (notif.method === "CANCEL_TOOL") {
      this.instances.handleCancelTool(notif.params, channel);
      return;
    }
    this.logger.debug(`unknown notification method "${notif.method}"`, { component: "daemon" });
  }

  private refuseSession(requestId: string): DaemonResponse {
    this.refusedSessions.offer(undefined);
    return errorResponse(requestId, ERROR_CODE_BRIDGE_UNSUPPORTED, SESSION_REFUSAL);
  }

  /** Admin RESTART: start the STDIO server with `params.upstreamHash` again. */
  private handleRestart(reqId: string, rawParams: unknown): DaemonResponse {
    const params = parseRestartParams(rawParams);
    if (params === null) {
      return errorResponse(reqId, ERROR_CODE_INVALID_PARAMS, "RESTART params must be { upstreamHash: string }");
    }
    const result: RestartResult = { ok: true, restarted: this.instances.restartChild(params.upstreamHash) };
    return { id: reqId, result };
  }

  private armIdleTimer(): void {
    this.cancelIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.stopping && this.isUnused()) {
        void this.stop(0, "idle");
      }
    }, this.opts.idleMs);
    if (typeof this.idleTimer.unref === "function") {
      this.idleTimer.unref();
    }
  }

  private isUnused(): boolean {
    return this.connections.size === 0 && this.instances.isEmpty;
  }

  private armIdleTimerIfUnused(): void {
    if (!this.stopping && this.isUnused()) this.armIdleTimer();
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
    await ensurePrivateDir(dirname(this.opts.lockPath), "daemon run dir");
  }
}

function parseRestartParams(raw: unknown): RestartParams | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.upstreamHash !== "string" || r.upstreamHash.length === 0) return null;
  return { upstreamHash: r.upstreamHash };
}

export { LockBusyError };

export class DaemonStoppedWhileStartingError extends Error {
  constructor() {
    super("daemon was stopped while starting");
    this.name = "DaemonStoppedWhileStartingError";
  }
}

export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly socketPath: string) {
    super(`a daemon is already serving ${socketPath}`);
    this.name = "DaemonAlreadyRunningError";
  }
}
