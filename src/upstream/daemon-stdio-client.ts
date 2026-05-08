import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type { StdioServerConfig } from "../config/schema.js";
import { APP_NAME, APP_VERSION } from "../constants.js";
import {
  DaemonLivenessSupervisor,
  ensureDaemonRunning,
  getDaemonLockPath,
  getDaemonPidPath,
  getDaemonSocketPath,
  INNER_ERROR_CODE_UPSTREAM_RESTARTED,
  type DaemonNotification,
} from "../daemon/index.js";
import { BaseUpstreamClient } from "./base-client.js";
import type { BaseUpstreamClientOptions } from "./base-client.js";
import { IdempotencyTable } from "./idempotency-table.js";

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
  _ensureDaemon?: () => Promise<void>;
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
  private readonly _ensureDaemon: () => Promise<void>;
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
      (async () => {
        await ensureDaemonRunning({ socketPath: this._socketPath });
      });
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
      lockPath: getDaemonLockPath(),
      pidPath: getDaemonPidPath(),
      ensureDaemon: this._ensureDaemon,
      rpcTimeoutMs: this._rpcTimeoutMs,
      heartbeatMs: this._heartbeatMs,
      respawnLockWaitMs: this._respawnLockWaitMs,
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
  ensureDaemon: () => Promise<void>;
  /** Per-RPC timeout for outbound daemon calls. */
  rpcTimeoutMs: number;
  /** Heartbeat cadence. */
  heartbeatMs: number;
  /** Lock-wait bound during respawn. */
  respawnLockWaitMs: number;
}

/**
 * MCP `Transport` implementation that piggybacks on the manager daemon. The
 * `start()` call sends `OPEN`; `send()` posts `RPC` notification frames;
 * inbound `RPC` frames matching this transport's `sessionId` are forwarded
 * to `onmessage`.
 */
class DaemonStdioTransport implements Transport {
  // Intentionally NOT exposing this as `sessionId` on the transport — the
  // MCP SDK Client treats a preset `transport.sessionId` as a reconnect
  // signal and SKIPS the initialize handshake. We need init to run every
  // time. Daemon routing uses `_daemonSessionId` internally.
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;

  private readonly _daemonSessionId: string;
  private readonly opts: DaemonStdioTransportOpts;
  private supervisor: DaemonLivenessSupervisor;
  private idempotency = new IdempotencyTable();
  private opened = false;
  private closing = false;

  constructor(opts: DaemonStdioTransportOpts) {
    this.opts = opts;
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
    this.supervisor.on("respawned", () => {
      void this._reopenAfterRespawn();
    });
    this.supervisor.on("respawnFailed", (err) => this._onRespawnFailed(err));
    this.supervisor.on("livenessFailure", () => {
      // The supervisor's force-respawn flow runs autonomously; the transport
      // doesn't need to react here. We listen so a future ops-metrics hook
      // has a place to plug in.
    });
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
    this.idempotency.track(message);
    const ok = this.supervisor.sendNotification("RPC", {
      sessionId: this._daemonSessionId,
      payload: message,
    });
    if (!ok) {
      throw new Error("daemon socket backpressure (RPC notification dropped)");
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
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
  private async _issueOpen(): Promise<void> {
    await this.supervisor.call("OPEN", {
      sessionId: this._daemonSessionId,
      spec: {
        serverName: this.opts.serverName,
        command: this.opts.command,
        args: this.opts.args,
        resolvedEnv: this.opts.resolvedEnv,
        cwd: this.opts.cwd,
        sharing: this.opts.sharing,
        // `${APP_NAME}/${serverName}` matches the per-upstream Client
        // identity in BaseUpstreamClient — the daemon-spawned child sees the
        // same `clientInfo.name` it would see if the bridge spawned it
        // directly.
        clientInfo: {
          name: `${APP_NAME}/${this.opts.serverName}`,
          version: APP_VERSION,
        },
        // The bridge currently advertises no client-side MCP features (no
        // sampling, roots, or elicitation handlers), so we ship `{}`.
        clientCapabilities: {},
        protocolVersion: LATEST_PROTOCOL_VERSION,
      },
    });
  }

  /**
   * Triggered by `supervisor.on("respawned")` after a successful force-respawn.
   * Re-OPENs the session against the new daemon, then drains the idempotency
   * table (Task 13): retryable in-flight requests are re-sent verbatim;
   * non-retryable ones get synthetic `daemon_respawn` errors so the MCP
   * client rejects the pending Promise.
   */
  private async _reopenAfterRespawn(): Promise<void> {
    if (this.closing) return;
    try {
      await this._issueOpen();
    } catch (err) {
      this._onRespawnFailed(err);
      return;
    }
    const snap = this.idempotency.snapshotForRetry();
    for (const m of snap.evicted) {
      const id = (m as { id?: string | number }).id;
      if (id === undefined) continue;
      this.onmessage?.(this._synthRespawnError(id, "upstream restarted"));
    }
    for (const m of snap.retryable) {
      const ok = this.supervisor.sendNotification("RPC", {
        sessionId: this._daemonSessionId,
        payload: m,
      });
      if (!ok) {
        const id = (m as { id?: string | number }).id;
        if (id !== undefined) {
          this.onmessage?.(
            this._synthRespawnError(id, "upstream restarted (resend backpressure)"),
          );
        }
      }
    }
    // Clear the table; new responses will repopulate via track/onResponse.
    // Resent retryable requests retain their pending entry on the MCP Client
    // and resolve when the response comes back.
    this.idempotency.clear();
  }

  private _onRespawnFailed(err: unknown): void {
    const snap = this.idempotency.snapshotForRetry();
    const msg = err instanceof Error ? err.message : String(err);
    for (const m of [...snap.retryable, ...snap.evicted]) {
      const id = (m as { id?: string | number }).id;
      if (id === undefined) continue;
      this.onmessage?.(this._synthRespawnError(id, `upstream restarted: ${msg}`));
    }
    this.idempotency.clear();
    void this.supervisor.close();
    this._onSocketClose();
  }

  private _synthRespawnError(id: string | number, message: string): JSONRPCMessage {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: INNER_ERROR_CODE_UPSTREAM_RESTARTED,
        message,
        data: { reason: "daemon_respawn" },
      },
    } as JSONRPCMessage;
  }

  private _onNotification(notif: DaemonNotification): void {
    if (notif.method === "SESSION_EVICTED") {
      const params = notif.params as { sessionId?: string; reason?: string } | undefined;
      if (params && params.sessionId === this._daemonSessionId) {
        const reasonErr = new Error(`daemon evicted session: ${params.reason ?? "unknown"}`);
        this.onerror?.(reasonErr);
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
    const err = new Error("daemon connection closed");
    this.onerror?.(err);
    this.onclose?.();
  }
}
