import { stat } from "node:fs/promises";
import { ConfigError, loadConfig } from "../../config/loader.js";
import { loadMergedConfig } from "../../config/merged-loader.js";
import { CredentialStore } from "../../credentials/credential-store.js";
import { createKeychainAdapter } from "../../credentials/keychain.js";
import type { Logger } from "../../logging/index.js";
import {
  ERROR_CODE_ALREADY_ATTACHED,
  ERROR_CODE_BRIDGE_UNSUPPORTED,
  ERROR_CODE_DAEMON_STOPPING,
  ERROR_CODE_INSTANCE_LOAD_FAILED,
  ERROR_CODE_INVALID_PARAMS,
  ERROR_CODE_NOT_ATTACHED,
  ERROR_CODE_TOO_MANY_CALLS,
  ERROR_CODE_TOO_MANY_INSTANCES,
  ERROR_CODE_UNKNOWN_UPSTREAM,
  ERROR_CODE_UPSTREAM_ERROR,
  MIN_BRIDGE_PROTOCOL_VERSION,
  MAX_CALLS_PER_BRIDGE,
  errorResponse,
  notInDaemonConfig,
  type AttachResult,
  type AuthChangedResult,
  type DaemonResponse,
  type InstanceSource,
  type StatusChild,
  type StatusInstance,
  type StatusUpstream,
} from "../protocol.js";
import type { FrameChannel } from "../transport.js";
import type { CreateHttpClient } from "./http-connection.js";
import { instanceKey } from "./identity.js";
import { Instance, type InstanceAttachment, type InstanceDeps, type InstanceEnv, type InstanceNotification, type LoadedConfig } from "./instance.js";
import { UpstreamPool, type UpstreamPoolOptions } from "./upstream-pool.js";
import { bridgeProtocolVersionOf, parseAttachParams, parseAuthChangedParams, parseCallToolParams, parseCancelToolParams, parseRetryParams } from "./params.js";

const MAX_INSTANCES = 64;

export interface InstanceHostOptions {
  /** How long an instance outlives its last attached bridge. */
  idleMs: number;
  logger: Logger;
  /** Called when the last instance closes, and when the last STDIO server it left running stops. */
  onIdle: () => void;
  stdio: UpstreamPoolOptions["stdio"];
  loadConfig?: (source: InstanceSource) => Promise<LoadedConfig>;
  createCredentialStore?: (env: Record<string, string>) => CredentialStore;
  createHttpClient?: CreateHttpClient;
  watchDebounceMs?: number;
}

interface Attachment extends InstanceAttachment {
  key: string;
  instance: Instance;
  calls: Map<string, AbortController>;
}

interface InstanceEntry {
  opening: Promise<Instance>;
  instance?: Instance;
  idleTimer?: NodeJS.Timeout;
}

/** The daemon's instances, and the bridges attached to them, one per socket. */
export class InstanceHost {
  private readonly _opts: InstanceHostOptions;
  private readonly _log: Logger;
  private readonly _pool: UpstreamPool;
  private readonly _deps: InstanceDeps;
  private readonly _entries = new Map<string, InstanceEntry>();
  private readonly _attachments = new Map<FrameChannel, Attachment>();
  private readonly _attaching = new Set<FrameChannel>();
  private readonly _closedChannels = new WeakSet<FrameChannel>();
  private _stopping = false;

  constructor(opts: InstanceHostOptions) {
    this._opts = opts;
    this._log = opts.logger.child({ component: "instance" });
    this._pool = new UpstreamPool({
      logger: opts.logger,
      createHttpClient: opts.createHttpClient,
      stdio: opts.stdio,
      onEmpty: () => this._idleIfEmpty(),
    });
    this._deps = {
      pool: this._pool,
      logger: opts.logger,
      loadConfig: opts.loadConfig ?? loadSource,
      createCredentialStore:
        opts.createCredentialStore ??
        ((env) => new CredentialStore({ keychain: createKeychainAdapter({ env }), logger: opts.logger.child({ component: "credentials" }) })),
      watchDebounceMs: opts.watchDebounceMs,
    };
  }

  /** No instance is open and no connection is open or closing. */
  get isEmpty(): boolean {
    return this._entries.size === 0 && this._pool.isEmpty;
  }

  async handleAttach(id: string, raw: unknown, channel: FrameChannel): Promise<DaemonResponse> {
    if (this._stopping) return errorResponse(id, ERROR_CODE_DAEMON_STOPPING, "manager is shutting down");
    const version = bridgeProtocolVersionOf(raw);
    if (version !== null && version < MIN_BRIDGE_PROTOCOL_VERSION) {
      return errorResponse(id, ERROR_CODE_BRIDGE_UNSUPPORTED, `ATTACH needs bridge protocol version ${MIN_BRIDGE_PROTOCOL_VERSION} or newer`);
    }
    const params = parseAttachParams(raw);
    if (params === null) return errorResponse(id, ERROR_CODE_INVALID_PARAMS, "ATTACH params malformed");
    if (this._attachments.has(channel) || this._attaching.has(channel)) {
      return errorResponse(id, ERROR_CODE_ALREADY_ATTACHED, "this connection is already attached");
    }
    const key = instanceKey(params.source, params.env);
    if (!this._entries.has(key) && this._entries.size >= MAX_INSTANCES) {
      return errorResponse(id, ERROR_CODE_TOO_MANY_INSTANCES, `manager instance cap reached (${MAX_INSTANCES})`);
    }
    this._attaching.add(channel);
    let opened: { instance: Instance; fresh: boolean };
    try {
      opened = await this._open(key, params.source, { env: params.env, childEnv: params.childEnv });
    } catch (err) {
      const reason = describeLoadError(err);
      this._log.warn("could not load config for bridge", { config: params.source.kind, error: reason });
      return errorResponse(id, ERROR_CODE_INSTANCE_LOAD_FAILED, reason);
    } finally {
      this._attaching.delete(channel);
    }
    if (this._stopping) return errorResponse(id, ERROR_CODE_DAEMON_STOPPING, "manager is shutting down");
    if (this._closedChannels.has(channel)) {
      this._idleIfUnused(key);
      return errorResponse(id, ERROR_CODE_NOT_ATTACHED, "connection closed while attaching");
    }
    const { instance, fresh } = opened;
    this._cancelIdle(key);
    const attachment: Attachment = {
      key,
      instance,
      calls: new Map(),
      send: (notification: InstanceNotification) => channel.send(notification),
    };
    this._attachments.set(channel, attachment);
    instance.attach(attachment);
    if (!fresh) await instance.reload();
    this._log.info("bridge attached", { config: params.source.kind, bridges: instance.attachmentCount });
    const result: AttachResult = { upstreams: instance.upstreamNames() };
    return { id, result };
  }

  async handleCallTool(id: string, raw: unknown, channel: FrameChannel): Promise<DaemonResponse> {
    const attachment = this._attachments.get(channel);
    if (attachment === undefined) return errorResponse(id, ERROR_CODE_NOT_ATTACHED, "CALL_TOOL before ATTACH");
    const params = parseCallToolParams(raw);
    if (params === null) return errorResponse(id, ERROR_CODE_INVALID_PARAMS, "CALL_TOOL params malformed");
    if (attachment.calls.has(params.callId)) return errorResponse(id, ERROR_CODE_INVALID_PARAMS, "callId already in use");
    if (attachment.calls.size >= MAX_CALLS_PER_BRIDGE) {
      return errorResponse(id, ERROR_CODE_TOO_MANY_CALLS, `too many calls in flight (${MAX_CALLS_PER_BRIDGE})`);
    }
    const controller = new AbortController();
    attachment.calls.set(params.callId, controller);
    try {
      const upstream = await attachment.instance.upstream(params.upstream);
      if (upstream === undefined) return unknownUpstream(id, params.upstream);
      const result = await upstream.callTool(
        { name: params.name, ...(params.arguments !== undefined && { arguments: params.arguments }) },
        { signal: controller.signal },
      );
      return { id, result };
    } catch (err) {
      return errorResponse(id, ERROR_CODE_UPSTREAM_ERROR, callFailure(err, controller.signal));
    } finally {
      attachment.calls.delete(params.callId);
    }
  }

  async handleRetry(id: string, raw: unknown, channel: FrameChannel): Promise<DaemonResponse> {
    const attachment = this._attachments.get(channel);
    if (attachment === undefined) return errorResponse(id, ERROR_CODE_NOT_ATTACHED, "RETRY before ATTACH");
    const params = parseRetryParams(raw);
    if (params === null) return errorResponse(id, ERROR_CODE_INVALID_PARAMS, "RETRY params malformed");
    const upstream = await attachment.instance.upstream(params.upstream);
    if (upstream === undefined) return unknownUpstream(id, params.upstream);
    return { id, result: await upstream.retry() };
  }

  /** Connects every upstream named in the params again, in every instance, so stored credentials that changed apply at once. */
  async handleAuthChanged(id: string, raw: unknown): Promise<DaemonResponse> {
    if (this._stopping) return errorResponse(id, ERROR_CODE_DAEMON_STOPPING, "manager is shutting down");
    const params = parseAuthChangedParams(raw);
    if (params === null) return errorResponse(id, ERROR_CODE_INVALID_PARAMS, "AUTH_CHANGED params malformed");
    const connections = await this._pool.credentialsChanged(params.upstream);
    this._log.info("credentials changed; connecting again", { server: params.upstream, connections });
    const result: AuthChangedResult = { connections };
    return { id, result };
  }

  handleCancelTool(raw: unknown, channel: FrameChannel): void {
    const params = parseCancelToolParams(raw);
    if (params !== null) this._attachments.get(channel)?.calls.get(params.callId)?.abort(new Error("Request cancelled"));
  }

  channelClosed(channel: FrameChannel): void {
    this._closedChannels.add(channel);
    const attachment = this._attachments.get(channel);
    if (attachment === undefined) return;
    this._attachments.delete(channel);
    for (const controller of attachment.calls.values()) controller.abort(new Error("bridge disconnected"));
    attachment.instance.detach(attachment);
    this._log.info("bridge detached", { config: attachment.instance.source.kind, bridges: attachment.instance.attachmentCount });
    this._idleIfUnused(attachment.key);
  }

  statusInstances(): StatusInstance[] {
    const out: StatusInstance[] = [];
    for (const entry of this._entries.values()) if (entry.instance) out.push(entry.instance.status());
    return out;
  }

  statusUpstreams(): StatusUpstream[] {
    return this._pool
      .upstreams()
      .map((upstream): StatusUpstream => {
        const row = { serverName: upstream.name, status: upstream.status, instances: upstream.instanceCount };
        const { type } = upstream.connection;
        return type === "stdio" ? { ...row, type, upstreamHash: upstream.key } : { ...row, type };
      })
      .sort((a, b) => a.serverName.localeCompare(b.serverName));
  }

  statusChildren(): StatusChild[] {
    return this._pool
      .children()
      .map(({ pid, key, serverName, era, startedAt, instances }) => ({ pid, upstreamHash: key, serverName, era, startedAt, instances }))
      .sort((a, b) => a.serverName.localeCompare(b.serverName));
  }

  /** Starts the STDIO server with this `upstreamHash` again; returns how many were. */
  restartChild(upstreamHash: string): number {
    return this._pool.restart(upstreamHash);
  }

  /** Closes every instance and connection, letting refreshes save their tokens for a moment, never longer than `maxSaveWaitMs`. */
  async close(maxSaveWaitMs: number): Promise<void> {
    this._stopping = true;
    for (const attachment of this._attachments.values()) {
      for (const controller of attachment.calls.values()) controller.abort(new Error("daemon shutdown"));
    }
    this._attachments.clear();
    const entries = [...this._entries.values()];
    this._entries.clear();
    for (const entry of entries) clearTimeout(entry.idleTimer);
    await Promise.allSettled(entries.map(async (entry) => (await entry.opening).close()));
    await this._pool.close(maxSaveWaitMs);
  }

  /** `fresh` when the config was loaded for this open, so it needn't be read again. */
  private async _open(key: string, source: InstanceSource, env: InstanceEnv): Promise<{ instance: Instance; fresh: boolean }> {
    const existing = this._entries.get(key);
    if (existing?.instance !== undefined) return { instance: existing.instance, fresh: false };
    return { instance: await (existing?.opening ?? this._startOpening(key, source, env)), fresh: true };
  }

  private _startOpening(key: string, source: InstanceSource, env: InstanceEnv): Promise<Instance> {
    const entry: InstanceEntry = { opening: Instance.open(source, env, this._deps) };
    this._entries.set(key, entry);
    entry.opening.then(
      (instance) => {
        if (this._entries.get(key) === entry) entry.instance = instance;
        else void instance.close();
      },
      () => {
        if (this._entries.get(key) === entry) this._entries.delete(key);
        this._idleIfEmpty();
      },
    );
    return entry.opening;
  }

  private _idleIfEmpty(): void {
    if (this.isEmpty) this._opts.onIdle();
  }

  private _cancelIdle(key: string): void {
    const entry = this._entries.get(key);
    if (entry === undefined) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  private _idleIfUnused(key: string): void {
    const entry = this._entries.get(key);
    if (entry?.instance === undefined || entry.instance.attachmentCount > 0 || entry.idleTimer !== undefined) return;
    const instance = entry.instance;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (this._entries.get(key) !== entry || instance.attachmentCount > 0) return;
      this._entries.delete(key);
      this._log.info("instance closed", { config: instance.source.kind, reason: "idle" });
      void instance.close().finally(() => this._idleIfEmpty());
    }, this._opts.idleMs);
    entry.idleTimer.unref();
  }
}

async function loadSource(source: InstanceSource): Promise<LoadedConfig> {
  const found = await stat(source.path).catch(() => undefined);
  if (found !== undefined && !found.isFile()) throw new ConfigError(`Config file is not a regular file: ${source.path}`);
  if (source.kind === "merged") return loadMergedConfig({ bridgeConfigPath: source.path });
  return { config: await loadConfig({ configPath: source.path }), watchPaths: [source.path] };
}

function describeLoadError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (!(err instanceof ConfigError) || err.issues.length === 0) return err.message;
  return `${err.message}: ${err.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`;
}

function unknownUpstream(id: string, name: string): DaemonResponse {
  return errorResponse(id, ERROR_CODE_UNKNOWN_UPSTREAM, notInDaemonConfig(name));
}

function callFailure(err: unknown, signal: AbortSignal): string {
  const cause = signal.aborted && signal.reason instanceof Error ? signal.reason : err;
  return cause instanceof Error ? cause.message : String(cause);
}
