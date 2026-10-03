import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";
import type { Transport, JSONRPCMessage } from "@modelcontextprotocol/client";
import type { StdioServerConfig } from "../config/schema.js";
import {
  DaemonLivenessSupervisor,
  ensureDaemonRunning,
  daemonFilesFor,
  getDaemonSocketPath,
  INNER_ERROR_CODE_UPSTREAM_RESTARTED,
  DaemonRpcError,
  DAEMON_CONNECTION_CLOSED,
  DAEMON_REJECTED,
  ERROR_CODE_SESSION_IN_USE,
  type DaemonNotification,
  type EnsureAttemptOptions,
} from "../daemon/index.js";
import type { LivenessFailureKind } from "../daemon/liveness-supervisor.js";
import { createNoopLogger, type Logger } from "../logging/index.js";
import { BaseUpstreamClient, upstreamClientInfo } from "./base-client.js";
import type { BaseUpstreamClientOptions } from "./base-client.js";
import { IdempotencyTable } from "./idempotency-table.js";
import { HeldOutbound } from "./held-outbound.js";
import { cancelledRequestId, requestIdOf, type RequestId } from "./jsonrpc-ids.js";

const OPEN_ATTEMPTS = 5;
const OPEN_RETRY_MS = 100;
const INTERNAL_ERROR = -32603;

export interface DaemonStdioClientOptions extends BaseUpstreamClientOptions {
  config: StdioServerConfig;
  /**
   * Resolves the env to ship in `OPEN` (after credential-template expansion).
   * Re-invoked on every connect/reconnect so a rotated credential reaches the
   * next-spawned child — matches `HttpUpstreamClient`'s `_prepareConnect`.
   * Either this OR `resolvedEnv` (legacy / test seam) must be provided.
   */
  resolveEnv?: () => Promise<Record<string, string>>;
  /** Static env, used when `resolveEnv` is absent. Cannot rotate. */
  resolvedEnv?: Record<string, string>;
  /** Override for tests: alternative socket path. */
  _socketPath?: string;
  /** Override for tests: skips real spawn + socket probe. */
  _ensureDaemon?: (opts?: EnsureAttemptOptions) => Promise<void>;
  /**
   * Per-RPC timeout (ms) on outbound daemon calls. Plumbed from
   * `_bridge.daemon.rpcTimeoutMs`. Defaults to 30_000 when omitted.
   */
  rpcTimeoutMs?: number;
  /** Heartbeat cadence (ms) for `DaemonLivenessSupervisor`. Defaults to 5_000. */
  heartbeatMs?: number;
  /** Bound on lock-wait during a two-bridge respawn race. Defaults to 60_000. */
  respawnLockWaitMs?: number;
}

/**
 * STDIO upstream that runs in the per-user manager daemon, not in the bridge
 * process. Speaks the daemon wire protocol: one `OPEN` per connect, `RPC`
 * notifications in both directions for MCP JSON-RPC traffic, `CLOSE` on
 * teardown.
 *
 * Phase B: one socket connection per upstream session. Phase C will keep the
 * same shape; the daemon dedupes identical specs to a single child internally.
 */
export class DaemonStdioClient extends BaseUpstreamClient {
  private readonly _config: StdioServerConfig;
  private readonly _resolveEnv: () => Promise<Record<string, string>>;
  private readonly _socketPath: string;
  private readonly _ensureDaemon: (opts?: EnsureAttemptOptions) => Promise<void>;
  private readonly _rpcTimeoutMs: number;
  private readonly _heartbeatMs: number;
  private readonly _respawnLockWaitMs: number;
  private _currentEnv: Record<string, string> = {};

  constructor(options: DaemonStdioClientOptions) {
    super(options);
    this._config = options.config;
    if (options.resolveEnv) {
      this._resolveEnv = options.resolveEnv;
    } else {
      const staticEnv = options.resolvedEnv ?? {};
      this._resolveEnv = async () => staticEnv;
    }
    this._socketPath = options._socketPath ?? getDaemonSocketPath();
    this._ensureDaemon =
      options._ensureDaemon ??
      ((opts) => ensureDaemonRunning({ socketPath: this._socketPath, ...opts }));
    this._rpcTimeoutMs = options.rpcTimeoutMs ?? 30_000;
    this._heartbeatMs = options.heartbeatMs ?? 5_000;
    this._respawnLockWaitMs = options.respawnLockWaitMs ?? 60_000;
  }

  /**
   * Re-resolve credentials before each connect attempt so token rotation
   * actually reaches the daemon-spawned child.
   */
  protected override async _prepareConnect(): Promise<void> {
    this._currentEnv = await this._resolveEnv();
  }

  protected _buildTransport(): Transport {
    return new DaemonStdioTransport({
      serverName: this.name,
      command: this._config.command,
      args: this._config.args ?? [],
      resolvedEnv: this._currentEnv,
      cwd: this._config.cwd ?? "",
      sharing: this._config._bridge?.sharing ?? "auto",
      socketPath: this._socketPath,
      ...daemonFilesFor(this._socketPath),
      ensureDaemon: this._ensureDaemon,
      rpcTimeoutMs: this._rpcTimeoutMs,
      heartbeatMs: this._heartbeatMs,
      respawnLockWaitMs: this._respawnLockWaitMs,
      logger: this._logger,
    });
  }
}

interface DaemonStdioTransportOpts {
  serverName: string;
  command: string;
  args: string[];
  resolvedEnv: Record<string, string>;
  cwd: string;
  sharing: "auto" | "shared" | "dedicated";
  socketPath: string;
  /** Daemon lockfile path. Required for force-respawn. */
  lockPath: string;
  /** Daemon pidfile path. Required for SIGKILL fallback in force-respawn. */
  pidPath: string;
  ensureDaemon: (opts?: EnsureAttemptOptions) => Promise<void>;
  /** Per-RPC timeout for outbound daemon calls. */
  rpcTimeoutMs: number;
  /** Heartbeat cadence. */
  heartbeatMs: number;
  /** Lock-wait bound during respawn. */
  respawnLockWaitMs: number;
  /** Optional logger; defaults to noop. Used to emit force-respawn structured logs. */
  logger?: Logger;
}

/**
 * MCP `Transport` implementation that piggybacks on the manager daemon. The
 * `start()` call sends `OPEN`; `send()` posts `RPC` notification frames;
 * inbound `RPC` frames matching this transport's `sessionId` are forwarded
 * to `onmessage`.
 */
interface ClassifiedAsStdioByEraProbe {
  readonly stderr: null;
  readonly pid: null;
}

class DaemonStdioTransport implements Transport, ClassifiedAsStdioByEraProbe {
  // Intentionally NOT exposing this as `sessionId` on the transport — the
  // MCP SDK Client treats a preset `transport.sessionId` as a reconnect
  // signal and SKIPS the initialize handshake. We need init to run every
  // time. Daemon routing uses `_daemonSessionId` internally.
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  readonly stderr = null;
  readonly pid = null;

  private readonly _daemonSessionId: string;
  private readonly opts: DaemonStdioTransportOpts;
  private readonly _logger: Logger;
  private supervisor: DaemonLivenessSupervisor;
  private idempotency = new IdempotencyTable();
  private held: HeldOutbound | null = null;
  private connectionGeneration = 0;
  private opened = false;
  private closing = false;

  constructor(opts: DaemonStdioTransportOpts) {
    this.opts = opts;
    this._logger = opts.logger ?? createNoopLogger();
    this._daemonSessionId = randomUUID();
    this.supervisor = new DaemonLivenessSupervisor({
      socketPath: opts.socketPath,
      rpcTimeoutMs: opts.rpcTimeoutMs,
      heartbeatMs: opts.heartbeatMs,
      respawnLockWaitMs: opts.respawnLockWaitMs,
      lockPath: opts.lockPath,
      pidPath: opts.pidPath,
      onNotification: (notif) => this._onNotification(notif),
      _ensureDaemonRunning: opts.ensureDaemon,
    });
    this.supervisor.on("livenessFailure", () => {
      this._nextConnection();
      if (!this.closing) this.held ??= new HeldOutbound();
    });
    this.supervisor.on("respawned", (reason: LivenessFailureKind) => {
      this._logger.info("force_respawn", {
        component: "daemon-stdio",
        event: "force_respawn",
        sessionId: this._daemonSessionId,
        reason,
        sessionsReopened: this.closing ? 0 : 1,
      });
      void this._reopenAfterRespawn(this._nextConnection());
    });
    this.supervisor.on("respawnFailed", (err) => this._onRespawnFailed(err));
  }

  async start(): Promise<void> {
    await this.opts.ensureDaemon();
    await this.supervisor.connect();
    try {
      await this._issueOpen();
    } catch (err) {
      // OPEN failure (spawn failed, validation rejected, RPC timeout): close
      // the supervisor so we don't leak a connection + heartbeat for every
      // retry.
      await this.supervisor.close();
      throw err;
    }
    this.opened = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closing) throw new Error("daemon transport is closed");
    if (this.held !== null) {
      this._hold(this.held, message);
      return;
    }
    if (!this._write(message)) throw new Error(this._writeFailure());
  }

  private _hold(held: HeldOutbound, message: JSONRPCMessage): void {
    const cancelled = cancelledRequestId(message);
    if (cancelled === undefined) held.hold(message);
    else if (!held.cancel(cancelled)) this.idempotency.forget(cancelled);
  }

  private _write(message: JSONRPCMessage): boolean {
    const written = this.supervisor.sendNotification("RPC", {
      sessionId: this._daemonSessionId,
      payload: message,
    });
    if (written) this.idempotency.track(message);
    return written;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.held = null;
    if (this.opened) {
      try {
        await this.supervisor.call("CLOSE", { sessionId: this._daemonSessionId });
      } catch {
        // Daemon may already be gone, or socket killed mid-call. Either way
        // we're tearing down anyway.
      }
      this.opened = false;
    }
    await this.supervisor.close();
    this.onclose?.();
  }

  /** Issue a fresh OPEN against the (possibly newly-respawned) supervisor. */
  private async _issueOpen(generation = this.connectionGeneration): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this._sendOpen();
        return;
      } catch (err) {
        const previousConnectionStillAttached =
          err instanceof DaemonRpcError && err.code === ERROR_CODE_SESSION_IN_USE;
        if (!previousConnectionStillAttached || attempt >= OPEN_ATTEMPTS) throw err;
        await delay(OPEN_RETRY_MS);
        if (generation !== this.connectionGeneration) throw err;
      }
    }
  }

  private _nextConnection(): number {
    return ++this.connectionGeneration;
  }

  private _takeHeld(): JSONRPCMessage[] {
    const held = this.held?.drain() ?? [];
    this.held = null;
    return held;
  }

  private async _sendOpen(): Promise<void> {
    await this.supervisor.call("OPEN", {
      sessionId: this._daemonSessionId,
      spec: {
        serverName: this.opts.serverName,
        command: this.opts.command,
        args: this.opts.args,
        resolvedEnv: this.opts.resolvedEnv,
        cwd: this.opts.cwd,
        sharing: this.opts.sharing,
        clientInfo: upstreamClientInfo(this.opts.serverName),
        // The bridge currently advertises no client-side MCP features (no
        // sampling, roots, or elicitation handlers), so we ship `{}`.
        clientCapabilities: {},
        protocolVersion: LATEST_PROTOCOL_VERSION,
      },
    });
  }

  private async _reopenAfterRespawn(generation: number): Promise<void> {
    if (this.closing) return;
    try {
      await this._issueOpen(generation);
    } catch (err) {
      if (generation === this.connectionGeneration) this._onRespawnFailed(err);
      return;
    }
    if (this.closing || generation !== this.connectionGeneration) return;
    const held = this._takeHeld();
    const { retryable, evicted } = this.idempotency.snapshotForRetry();
    this.idempotency.clear();
    this._failRespawned(evicted, "upstream restarted");
    this._resend([...retryable, ...held]);
  }

  private _resend(messages: JSONRPCMessage[]): void {
    for (const message of messages) {
      if (this._write(message)) continue;
      if (this.supervisor.connected) this._failRejected(message);
      else (this.held ??= new HeldOutbound()).hold(message);
    }
  }

  private _writeFailure(): string {
    return this.supervisor.connected ? DAEMON_REJECTED : DAEMON_CONNECTION_CLOSED;
  }

  private _onRespawnFailed(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    const { retryable, evicted } = this.idempotency.snapshotForRetry();
    const pending = [...retryable, ...evicted, ...this._takeHeld()];
    this.idempotency.clear();
    this._failRespawned(pending, `upstream restarted: ${msg}`);
    void this.supervisor.close();
    this._onSocketClose();
  }

  private _failRespawned(messages: JSONRPCMessage[], message: string): void {
    for (const m of messages) {
      const id = requestIdOf(m);
      if (id !== undefined) {
        this.onmessage?.(synthError(id, INNER_ERROR_CODE_UPSTREAM_RESTARTED, message, "daemon_respawn"));
      }
    }
  }

  private _failRejected(message: JSONRPCMessage): void {
    const id = requestIdOf(message);
    if (id !== undefined) this.onmessage?.(synthError(id, INTERNAL_ERROR, DAEMON_REJECTED, "daemon_rejected"));
  }



  private _onNotification(notif: DaemonNotification): void {
    if (notif.method === "SESSION_EVICTED") {
      const params = notif.params as { sessionId?: string; reason?: string } | undefined;
      if (params && params.sessionId === this._daemonSessionId) {
        const reasonErr = new Error(`daemon evicted session: ${params.reason ?? "unknown"}`);
        this.onerror?.(reasonErr);
        void this.supervisor.close();
        this._onSocketClose();
      }
      return;
    }
    if (notif.method !== "RPC") return;
    const params = notif.params as { sessionId?: string; payload?: unknown } | undefined;
    if (!params || params.sessionId !== this._daemonSessionId) return;
    if (params.payload === undefined) return;
    // Forget tracked outbound on response.
    this.idempotency.onResponse(params.payload as JSONRPCMessage);
    try {
      this.onmessage?.(params.payload as JSONRPCMessage);
    } catch (err) {
      this.onerror?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private _onSocketClose(): void {
    if (this.closing) return;
    this.closing = true;
    this.held = null;
    const err = new Error(DAEMON_CONNECTION_CLOSED);
    this.onerror?.(err);
    this.onclose?.();
  }
}

function synthError(id: RequestId, code: number, message: string, reason: string): JSONRPCMessage {
  return { jsonrpc: "2.0", id, error: { code, message, data: { reason } } } as JSONRPCMessage;
}
