import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { getBridgeConfigPath } from "../config/bridge-config.js";
import {
  DAEMON_CONNECTION_CLOSED,
  DaemonLivenessSupervisor,
  daemonFilesFor,
  ensureDaemonRunning,
  getDaemonSocketPath,
  type DaemonNotification,
  type EnsureAttemptOptions,
} from "../daemon/index.js";
import {
  PROTOCOL_VERSION,
  type AttachParams,
  type AttachResult,
  type InstanceSource,
  type UpstreamLogParams,
  type UpstreamRemovedParams,
  type UpstreamSnapshot,
} from "../daemon/protocol.js";
import { createNoopLogger, type Logger } from "../logging/index.js";
import { DEFAULT_RECONNECT_BASE_DELAY_MS, DEFAULT_RECONNECT_MAX_DELAY_MS } from "./base-client.js";
import { isConnectionStatus } from "./types.js";
import type { UpstreamReconnectInputs } from "./upstream-hash.js";

const NO_TIMEOUT = { timeoutMs: 0 };
const LINK_CLOSED = "instance link is closed";

/** The config this bridge loads, as the daemon should load it: an absolute file, or the merged default. */
export function instanceSourceFor(explicitPath: string | undefined): InstanceSource {
  return explicitPath ? { kind: "file", path: resolve(explicitPath) } : { kind: "merged", path: getBridgeConfigPath() };
}

/** The link as the upstream manager and its stand-ins use it. */
export type UpstreamLink = Pick<InstanceLink, "isAttached" | "attach" | "attachNow" | "snapshot" | "watch" | "callTool" | "retry" | "close">;

/** What a stand-in hears about its upstream from the link. */
export interface UpstreamView {
  onSnapshot(snapshot: UpstreamSnapshot): void;
  /** The instance doesn't have this upstream. */
  onRemoved(): void;
  /** The daemon is being replaced; snapshots follow once the link attaches again. */
  onInterrupted(): void;
  /** The link couldn't attach; it retries with backoff. */
  onDown(error: Error): void;
}

export interface InstanceLinkOptions {
  source: InstanceSource;
  env: Record<string, string>;
  logger?: Logger;
  rpcTimeoutMs: number;
  heartbeatMs: number;
  respawnLockWaitMs: number;
  /** Backoff between attempts to attach again after the daemon couldn't be reached. */
  reconnect?: UpstreamReconnectInputs;
  _socketPath?: string;
  _ensureDaemon?: (opts?: EnsureAttemptOptions) => Promise<void>;
}

/**
 * A bridge's one connection to its daemon instance, shared by the stand-ins
 * of every daemon-hosted upstream. Attaches on first use, attaches again
 * after the daemon is replaced, and backs off while it can't be reached.
 */
export class InstanceLink {
  private readonly _opts: InstanceLinkOptions;
  private readonly _logger: Logger;
  private readonly _socketPath: string;
  private readonly _ensureDaemon: (opts?: EnsureAttemptOptions) => Promise<void>;
  private readonly _snapshots = new Map<string, UpstreamSnapshot>();
  private readonly _views = new Map<string, Set<UpstreamView>>();
  private readonly _pendingCalls = new Set<(err: Error) => void>();
  private _supervisor: DaemonLivenessSupervisor | null = null;
  private _attaching: Promise<void> | null = null;
  private _respawning: Deferred | null = null;
  private _attached = false;
  private _closed = false;
  private _failures = 0;
  private _lastFailure: { at: number; error: Error } | null = null;
  private _retryTimer: NodeJS.Timeout | undefined;

  constructor(opts: InstanceLinkOptions) {
    this._opts = opts;
    this._logger = opts.logger ?? createNoopLogger();
    this._socketPath = opts._socketPath ?? getDaemonSocketPath();
    this._ensureDaemon =
      opts._ensureDaemon ?? ((attempt) => ensureDaemonRunning({ socketPath: this._socketPath, logger: this._logger, ...attempt }));
  }

  get isAttached(): boolean {
    return this._attached;
  }

  snapshot(name: string): UpstreamSnapshot | undefined {
    return this._snapshots.get(name);
  }

  watch(name: string, view: UpstreamView): () => void {
    let views = this._views.get(name);
    if (views === undefined) this._views.set(name, (views = new Set()));
    views.add(view);
    return () => {
      views.delete(view);
      if (views.size === 0 && this._views.get(name) === views) this._views.delete(name);
    };
  }

  /** Resolves once attached; rejects with the daemon error when the daemon can't be reached. */
  attach(): Promise<void> {
    if (this._closed) return Promise.reject(new Error(LINK_CLOSED));
    if (this._attached) return Promise.resolve();
    if (this._respawning !== null) return this._respawning.promise;
    this._attaching ??= this._attachFresh().finally(() => {
      this._attaching = null;
    });
    return this._attaching;
  }

  /** Attaches now instead of waiting out the backoff, unless an attempt just failed. */
  attachNow(): Promise<void> {
    if (this._attached || this._attaching !== null || this._respawning !== null || this._lastFailure === null) return this.attach();
    if (Date.now() - this._lastFailure.at < this._baseDelay()) return Promise.reject(this._lastFailure.error);
    return this.attach();
  }

  /**
   * Asks the daemon to try the upstream now and tells its stand-ins where it
   * stands afterwards. The daemon sends every change before its reply, so the
   * latest snapshot is at least as new as the reply and wins over it.
   */
  async retry(name: string): Promise<UpstreamSnapshot> {
    const reply = await this._attachedSupervisor().call("RETRY", { upstream: name }, NO_TIMEOUT);
    const snapshot = snapshotOf(reply);
    if (snapshot === null) throw new Error(`malformed RETRY reply for "${name}"`);
    const latest = this._snapshots.get(name) ?? snapshot;
    this._onSnapshot(latest);
    return latest;
  }

  async callTool(
    upstream: string,
    params: { name: string; arguments?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    if (signal?.aborted) throw abortReason(signal);
    const supervisor = this._attachedSupervisor();
    const callId = randomUUID();
    return new Promise<CallToolResult>((resolvePromise, reject) => {
      const finish = (): void => {
        this._pendingCalls.delete(fail);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (err: Error): void => {
        finish();
        reject(err);
      };
      const onAbort = (): void => {
        supervisor.sendNotification("CANCEL_TOOL", { callId });
        fail(abortReason(signal!));
      };
      this._pendingCalls.add(fail);
      signal?.addEventListener("abort", onAbort, { once: true });
      supervisor
        .call("CALL_TOOL", { callId, upstream, name: params.name, ...(params.arguments && { arguments: params.arguments }) }, NO_TIMEOUT)
        .then(
          (result) => {
            finish();
            resolvePromise(result as CallToolResult);
          },
          (err: unknown) => fail(toError(err)),
        );
    });
  }

  async close(): Promise<void> {
    this._closed = true;
    this._attached = false;
    clearTimeout(this._retryTimer);
    this._failPendingCalls();
    this._settleRespawn(new Error(LINK_CLOSED));
    const supervisor = this._supervisor;
    this._supervisor = null;
    await supervisor?.close();
  }

  private _attachedSupervisor(): DaemonLivenessSupervisor {
    if (!this._attached || this._supervisor === null) throw new Error(DAEMON_CONNECTION_CLOSED);
    return this._supervisor;
  }

  private async _attachFresh(): Promise<void> {
    clearTimeout(this._retryTimer);
    this._retryTimer = undefined;
    const supervisor = this._newSupervisor();
    try {
      await this._ensureDaemon();
      await supervisor.connect();
      await this._sendAttach(supervisor);
    } catch (err) {
      await this._abandon(supervisor, err);
      throw toError(err);
    }
  }

  private _newSupervisor(): DaemonLivenessSupervisor {
    const supervisor = new DaemonLivenessSupervisor({
      socketPath: this._socketPath,
      ...daemonFilesFor(this._socketPath),
      rpcTimeoutMs: this._opts.rpcTimeoutMs,
      heartbeatMs: this._opts.heartbeatMs,
      respawnLockWaitMs: this._opts.respawnLockWaitMs,
      onNotification: (notification) => this._onNotification(notification),
      _ensureDaemonRunning: this._ensureDaemon,
    });
    supervisor.on("livenessFailure", () => {
      if (this._supervisor === supervisor) this._onInterrupted();
    });
    supervisor.on("respawned", () => {
      if (this._supervisor === supervisor) void this._attachAgain(supervisor);
    });
    supervisor.on("respawnFailed", (err: unknown) => {
      void this._abandon(supervisor, err);
    });
    this._supervisor = supervisor;
    return supervisor;
  }

  /** Closes `supervisor`; when it was the current one, drops it and reports the link down. */
  private async _abandon(supervisor: DaemonLivenessSupervisor, err: unknown): Promise<void> {
    const current = this._supervisor === supervisor;
    if (current) this._supervisor = null;
    await supervisor.close();
    if (current) this._onDown(toError(err));
  }

  private async _sendAttach(supervisor: DaemonLivenessSupervisor): Promise<void> {
    const params: AttachParams = { bridgeProtocolVersion: PROTOCOL_VERSION, source: this._opts.source, env: this._opts.env };
    const result = (await supervisor.call("ATTACH", params)) as AttachResult;
    if (this._closed || this._supervisor !== supervisor) throw new Error(LINK_CLOSED);
    const hosted = new Set(result.upstreams);
    this._attached = true;
    this._failures = 0;
    this._lastFailure = null;
    for (const name of new Set([...this._snapshots.keys(), ...this._views.keys()])) {
      if (!hosted.has(name)) this._onRemoved(name);
    }
    for (const snapshot of this._snapshots.values()) this._notifySnapshot(snapshot);
  }

  private async _attachAgain(supervisor: DaemonLivenessSupervisor): Promise<void> {
    if (this._closed) return;
    try {
      await this._sendAttach(supervisor);
      this._settleRespawn();
    } catch (err) {
      await this._abandon(supervisor, err);
    }
  }

  private _settleRespawn(error?: Error): void {
    const respawning = this._respawning;
    this._respawning = null;
    if (error === undefined) respawning?.resolve();
    else respawning?.reject(error);
  }

  private _onNotification(notification: DaemonNotification): void {
    const { method, params } = notification;
    const snapshot = method === "UPSTREAM" ? snapshotOf(params) : null;
    if (snapshot !== null) this._onSnapshot(snapshot);
    else if (method === "UPSTREAM_REMOVED" && isRemoval(params)) this._onRemoved(params.upstream);
    else if (method === "LOG" && isLog(params)) this._writeLog(params);
  }

  private _onSnapshot(snapshot: UpstreamSnapshot): void {
    this._snapshots.set(snapshot.name, snapshot);
    if (this._attached) this._notifySnapshot(snapshot);
  }

  private _notifySnapshot(snapshot: UpstreamSnapshot): void {
    for (const view of [...(this._views.get(snapshot.name) ?? [])]) view.onSnapshot(snapshot);
  }

  private _onRemoved(name: string): void {
    this._snapshots.delete(name);
    for (const view of [...(this._views.get(name) ?? [])]) view.onRemoved();
  }

  private _onInterrupted(): void {
    this._attached = false;
    this._respawning ??= deferred();
    this._failPendingCalls();
    this._eachView((view) => view.onInterrupted());
  }

  private _onDown(error: Error): void {
    this._attached = false;
    this._settleRespawn(error);
    this._failPendingCalls();
    this._lastFailure = { at: Date.now(), error };
    this._eachView((view) => view.onDown(error));
    this._scheduleAttach();
  }

  private _eachView(visit: (view: UpstreamView) => void): void {
    for (const views of [...this._views.values()]) for (const view of [...views]) visit(view);
  }

  private _scheduleAttach(): void {
    if (this._closed || this._retryTimer !== undefined || this._views.size === 0) return;
    const delay = Math.min(this._baseDelay() * 2 ** this._failures, this._maxDelay());
    this._failures++;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = undefined;
      this.attach().catch(() => {});
    }, delay);
  }

  private _maxDelay(): number {
    return this._opts.reconnect?.reconnectMaxDelay ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  }

  private _baseDelay(): number {
    return this._opts.reconnect?.reconnectBaseDelay ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  }

  private _failPendingCalls(): void {
    const error = new Error(DAEMON_CONNECTION_CLOSED);
    for (const fail of [...this._pendingCalls]) fail(error);
  }

  private _writeLog({ upstream, level, message, context }: UpstreamLogParams): void {
    const { component, ...rest } = context ?? {};
    const log = this._logger.child({ component: typeof component === "string" ? component : "upstream", server: upstream });
    log[level](message, Object.keys(rest).length > 0 ? rest : undefined);
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

function deferred(): Deferred {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolvePromise = res;
    rejectPromise = rej;
  });
  promise.catch(() => {});
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

/** The snapshot in `value`, or null when it isn't one; a status this bridge doesn't know reads as disconnected. */
function snapshotOf(value: unknown): UpstreamSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const { name, status, tools } = value as { name?: unknown; status?: unknown; tools?: unknown };
  if (typeof name !== "string" || typeof status !== "string" || !Array.isArray(tools)) return null;
  if (isConnectionStatus(status)) return value as UpstreamSnapshot;
  return { name, status: "disconnected", error: `the manager reported a status this bridge doesn't know: ${status}`, tools: [] };
}

function isRemoval(value: unknown): value is UpstreamRemovedParams {
  return typeof value === "object" && value !== null && typeof (value as Partial<UpstreamRemovedParams>).upstream === "string";
}

function isLog(value: unknown): value is UpstreamLogParams {
  if (typeof value !== "object" || value === null) return false;
  const { upstream, level, message } = value as Partial<UpstreamLogParams>;
  return typeof upstream === "string" && typeof message === "string" && (level === "warn" || level === "error");
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Request cancelled");
}
