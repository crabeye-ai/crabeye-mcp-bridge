import type { CallToolResult } from "@modelcontextprotocol/client";
import { ConfigWatcher } from "../../config/config-watcher.js";
import { ConfigError, describeConfigError } from "../../config/loader.js";
import { leftOutWarning, type SkippedFile } from "../../config/merged-loader.js";
import { findRemovedSettings, warnAboutConfig } from "../../config/removed-settings.js";
import { findSelfReferences, isHttpServer, resolveUpstreams, serverBridgeConfigs, type BridgeConfig, type RateLimitConfig, type ServerConfig } from "../../config/schema.js";
import type { CredentialStore } from "../../credentials/credential-store.js";
import type { Logger } from "../../logging/index.js";
import { PolicyEngine } from "../../policy/index.js";
import type { SearchToolsParams, SearchToolsResponse } from "../../search/index.js";
import { renderPassthrough } from "../../server/passthrough.js";
import { defaultLimitReachedMessage, resolveRateLimitConfig } from "../../server/rate-limit-resolution.js";
import { awaitConnectedClient } from "../../server/upstream-wait.js";
import { ApprovalRequiredError, CallRefusedError } from "../../upstream/call-errors.js";
import { resolveReconnectInputs } from "../../upstream/upstream-hash.js";
import type {
  InstanceSource,
  SettingsParams,
  StatusInstance,
  UpstreamLogParams,
  UpstreamRemovedParams,
  UpstreamSnapshot,
} from "../protocol.js";
import { httpUpstreamIdentity, stdioUpstreamKey } from "./identity.js";
import { hostedView, takeSlotFor, type HostedView } from "./hosted-calls.js";
import { ReportingLogger } from "./pooled-upstream.js";
import { ToolIndex } from "./tool-index.js";
import type { Lease, PoolSpec, UpstreamPool } from "./upstream-pool.js";

export interface LoadedConfig {
  config: BridgeConfig;
  watchPaths: string[];
  /** Each listed file that exists but was left out of `config`. */
  skipped?: SkippedFile[];
}

/** The client variables an instance reads, and the environment its STDIO servers start with. */
export interface InstanceEnv {
  env: Record<string, string>;
  childEnv: Record<string, string>;
}

export interface InstanceDeps {
  pool: UpstreamPool;
  logger: Logger;
  loadConfig: (source: InstanceSource) => Promise<LoadedConfig>;
  createCredentialStore: (env: Record<string, string>) => CredentialStore;
  watchDebounceMs?: number;
}

export type InstanceNotification =
  | { method: "UPSTREAM"; params: UpstreamSnapshot }
  | { method: "UPSTREAM_REMOVED"; params: UpstreamRemovedParams }
  | { method: "LOG"; params: UpstreamLogParams }
  | { method: "SETTINGS"; params: SettingsParams };

/** Where an instance sends what its bridges need to hear: one per attached socket. */
export interface InstanceAttachment {
  send(notification: InstanceNotification): void;
}

export interface HostedCallOptions {
  signal: AbortSignal;
  /** The bridge's client approved the call. */
  approved?: boolean;
}

/** One of an instance's upstreams, under the name the instance gives it. */
export interface HostedUpstream {
  /**
   * Checks the policy, waits for a slot under the server's rate limit and for
   * the server to connect, checks the policy again, then calls it. Rejects
   * with `ApprovalRequiredError` when the call needs approval it wasn't given.
   */
  callTool(params: { name: string; arguments?: Record<string, unknown> }, options: HostedCallOptions): Promise<CallToolResult>;
  retry(): Promise<UpstreamSnapshot>;
}

interface Hosted {
  key: string;
  lease: Lease;
  view: HostedView;
  unsubscribe: () => void;
}

/**
 * The daemon's copy of one config, shared by every bridge that would load it.
 * Holds a pooled connection for each server, the index `search_tools`
 * searches and the tool policy calls are checked against, and follows edits
 * to the files it loaded, telling its bridges what they need to hear of them.
 */
export class Instance {
  readonly source: InstanceSource;
  private readonly _env: Record<string, string>;
  private readonly _childEnv: Record<string, string>;
  private readonly _deps: InstanceDeps;
  private readonly _store: CredentialStore;
  private readonly _log: Logger;
  /** Logs to the manager log, and sends warnings and errors to every attached bridge too. */
  private readonly _configLog: Logger;
  private readonly _attachments = new Set<InstanceAttachment>();
  private readonly _hosted = new Map<string, Hosted>();
  private readonly _hostedChanged = new Set<() => void>();
  private readonly _policy: PolicyEngine;
  private readonly _index: ToolIndex;
  private _config: BridgeConfig;
  private _watcher: ConfigWatcher | undefined;
  private _watchPaths: readonly string[] = [];
  private _applying: Promise<void> = Promise.resolve();
  private _reloadRunning: Promise<void> | undefined;
  private _reloadQueued: Promise<void> | undefined;
  private _lastReloadError: string | undefined;
  /** The listed files the current config left out. */
  private _skipped: SkippedFile[] = [];
  /** The listed files the current config read. */
  private _included = new Set<string>();
  private _closed = false;

  private constructor(source: InstanceSource, { env, childEnv }: InstanceEnv, loaded: LoadedConfig, deps: InstanceDeps) {
    this.source = source;
    this._env = env;
    this._childEnv = childEnv;
    this._deps = deps;
    this._config = loaded.config;
    this._log = deps.logger.child({ component: "instance" });
    this._configLog = new ReportingLogger(this._log, (level, message, context) =>
      this._broadcast({ method: "LOG", params: { level, message, ...(Object.keys(context).length > 0 && { context }) } }),
    );
    this._store = deps.createCredentialStore(env);
    const servers = resolveUpstreams(loaded.config);
    this._policy = new PolicyEngine(loaded.config._bridge.toolPolicy, serverBridgeConfigs(servers));
    this._index = new ToolIndex(this._policy);
    for (const [name, config] of Object.entries(servers)) {
      this._host(name, this._specFor(name, config));
      this._index.setCategory(name, config._bridge?.category);
    }
    this._recordSkipped(loaded);
    this._watch(loaded.watchPaths);
  }

  /** Loads the config for `source`; rejects with the loader's error when it can't. */
  static async open(source: InstanceSource, env: InstanceEnv, deps: InstanceDeps): Promise<Instance> {
    return new Instance(source, env, await deps.loadConfig(source), deps);
  }

  get attachmentCount(): number {
    return this._attachments.size;
  }

  /** Sends the attachment a snapshot of every hosted upstream, then keeps it up to date. */
  attach(attachment: InstanceAttachment): void {
    this._attachments.add(attachment);
    for (const [name, { lease }] of this._hosted) attachment.send({ method: "UPSTREAM", params: { ...lease.upstream.snapshot(), name } });
  }

  /**
   * Attaches a bridge, reloading the config first when `reload` is set, then
   * warns it about each listed file that was already left out before that
   * reload and still is; a file the reload left out was announced to every
   * attachment as it happened.
   */
  async admit(attachment: InstanceAttachment, reload: boolean): Promise<void> {
    this.attach(attachment);
    const before = new Set(this._skipped.map(({ path }) => path));
    if (reload) await this.reload();
    for (const file of this._skipped) {
      if (before.has(file.path)) attachment.send({ method: "LOG", params: { level: "warn", message: leftOutWarning(file) } });
    }
  }

  upstreamNames(): string[] {
    return [...this._hosted.keys()];
  }

  detach(attachment: InstanceAttachment): void {
    this._attachments.delete(attachment);
  }

  /** The hosted upstream named `name`, reloading the config first when there is none. */
  async upstream(name: string): Promise<HostedUpstream | undefined> {
    if (!this._hosted.has(name)) await this.reload();
    const hosted = this._hosted.get(name);
    if (hosted === undefined) return undefined;
    return {
      callTool: (params, options) => this._call(name, params, options),
      retry: async () => ({ ...(await hosted.lease.upstream.retry()), name }),
    };
  }

  search(params: SearchToolsParams): SearchToolsResponse {
    return this._index.search(params);
  }

  /** The settings the config gives the instance's bridges. */
  settings(): SettingsParams {
    return { logLevel: this._config._bridge.logLevel };
  }

  /** The `_bridge.passthrough` blocks for a bridge's instructions, from what the servers have reported so far. */
  passthrough(): string {
    return renderPassthrough({
      upstreams: resolveUpstreams(this._config),
      getInstructions: (name) => this._hosted.get(name)?.lease.upstream.snapshot().instructions,
      getTools: (name) => this._index.tools(name),
      resolvePolicy: (name, toolName) => this._policy.resolvePolicy(name, toolName),
    });
  }

  /**
   * Loads the config again and applies what changed, keeping the current one
   * when it doesn't load. Calls made while a reload runs share one reload
   * that starts after it.
   */
  reload(): Promise<void> {
    if (this._reloadQueued !== undefined) return this._reloadQueued;
    if (this._reloadRunning === undefined) return this._startReload();
    const queued = this._reloadRunning.then(() => {
      this._reloadQueued = undefined;
      return this._startReload();
    });
    this._reloadQueued = queued;
    return queued;
  }

  status(): StatusInstance {
    return { source: this.source, bridges: this._attachments.size, upstreams: [...this._hosted.keys()].sort() };
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._watcher?.stop();
    await this._applying;
    for (const name of [...this._hosted.keys()]) this._unhost(name);
    this._attachments.clear();
    this._index.close();
  }

  private async _call(name: string, params: { name: string; arguments?: Record<string, unknown> }, { signal, approved }: HostedCallOptions): Promise<CallToolResult> {
    const before = this._policy.evaluate(name, params.name, params.arguments);
    if (before.kind === "deny") throw new CallRefusedError(before.reason);
    if (before.kind === "prompt" && approved !== true) throw new ApprovalRequiredError(before.message);
    await takeSlotFor(name, (current) => this._hosted.get(current)?.lease, signal);
    const upstream = await awaitConnectedClient(name, {
      getClient: (current) => this._hosted.get(current)?.view,
      onClientsChanged: (listener) => this._onHostedChanged(listener),
      signal,
      logger: this._log,
    });
    const after = this._policy.evaluate(name, params.name, params.arguments);
    if (after.kind === "deny") throw new CallRefusedError(after.reason);
    if (after.kind === "prompt" && approved !== true) throw new ApprovalRequiredError(after.message);
    return upstream.callTool(params, { signal });
  }

  private _onHostedChanged(listener: () => void): () => void {
    this._hostedChanged.add(listener);
    return () => this._hostedChanged.delete(listener);
  }

  private _watch(watchPaths: string[]): void {
    this._watchPaths = watchPaths;
    this._watcher = new ConfigWatcher({
      configPaths: watchPaths,
      loadConfig: async () => (await this._loadComplete()).config,
      onLoadError: (err) => this._reportLoadError(err),
      logger: this._configLog,
      debounceMs: this._deps.watchDebounceMs,
    });
    this._watcher.start((config) => this._enqueue(config), this._config);
  }

  private _startReload(): Promise<void> {
    const running = this._loadAndApply().finally(() => {
      if (this._reloadRunning === running) this._reloadRunning = undefined;
    });
    this._reloadRunning = running;
    return running;
  }

  private async _loadAndApply(): Promise<void> {
    let loaded: LoadedConfig;
    try {
      loaded = await this._loadComplete();
    } catch (err) {
      this._reportLoadError(err);
      return;
    }
    await this._enqueue(loaded.config);
    if (this._closed) return;
    const added = loaded.watchPaths.filter((path) => !this._watchPaths.includes(path));
    if (added.length === 0) {
      this._watcher?.markApplied(loaded.config);
      return;
    }
    this._watcher?.stop();
    this._watch([...this._watchPaths, ...added]);
    this._watcher?.checkNow();
  }

  /**
   * Loads the config, refusing one that leaves out a file the current config
   * included, so that a reload keeps the last good config instead of dropping
   * that file's servers. Records which files the loaded config leaves out.
   */
  private async _loadComplete(): Promise<LoadedConfig> {
    const loaded = await this._deps.loadConfig(this.source);
    const lost = (loaded.skipped ?? []).filter(({ path }) => this._included.has(path));
    if (lost.length > 0) throw new ConfigError(lost.map(({ message }) => message).join("; "));
    this._lastReloadError = undefined;
    this._recordSkipped(loaded);
    return loaded;
  }

  private _recordSkipped(loaded: LoadedConfig): void {
    const skipped = loaded.skipped ?? [];
    const isSkipped = (path: string) => skipped.some((file) => file.path === path);
    for (const file of skipped) if (!this._skipped.some(({ path }) => path === file.path)) this._configLog.warn(leftOutWarning(file));
    this._skipped = skipped;
    this._included = new Set(loaded.watchPaths.filter((path) => !isSkipped(path)));
  }

  /** Tells the manager log and every bridge that a reload failed, once while the same error lasts. */
  private _reportLoadError(err: unknown): void {
    const error = describeConfigError(err);
    if (error !== this._lastReloadError) this._configLog.warn("failed to reload config", { error });
    this._lastReloadError = error;
  }

  private _enqueue(config: BridgeConfig): Promise<void> {
    this._applying = this._applying
      .then(() => {
        if (!this._closed) this._apply(config);
      })
      .catch((err: unknown) => this._log.error("failed to apply config", { error: err instanceof Error ? err.message : String(err) }));
    return this._applying;
  }

  private _apply(next: BridgeConfig): void {
    const previous = this._config;
    this._config = next;
    const servers = resolveUpstreams(next);
    this._policy.update(next._bridge.toolPolicy, serverBridgeConfigs(servers));
    if (configWarnings(next) !== configWarnings(previous)) warnAboutConfig(next, this._configLog);
    if (next._bridge.logLevel !== previous._bridge.logLevel) this._broadcast({ method: "SETTINGS", params: this.settings() });
    if (next._bridge.logFormat !== previous._bridge.logFormat) this._configLog.warn("_bridge.logFormat changed; restart the AI clients to apply it");
    const toRelease: Hosted[] = [];
    for (const [name, config] of Object.entries(servers)) {
      const spec = this._specFor(name, config);
      const current = this._hosted.get(name);
      this._index.setCategory(name, config._bridge?.category);
      if (current?.key === spec.key) {
        current.lease.setRateLimit(spec.rateLimit);
        continue;
      }
      this._log.info(current === undefined ? "adding server" : "reconnecting server", { server: name });
      if (current !== undefined) toRelease.push(current);
      this._host(name, spec);
    }
    for (const name of [...this._hosted.keys()]) {
      if (Object.hasOwn(servers, name)) continue;
      this._log.info("removing server", { server: name });
      toRelease.push(this._hosted.get(name)!);
      this._hosted.delete(name);
      this._index.remove(name);
      this._broadcast({ method: "UPSTREAM_REMOVED", params: { upstream: name } });
    }
    for (const hosted of toRelease) release(hosted);
    if (toRelease.length > 0) this._notifyHostedChanged();
    const interval = next._bridge.healthCheckInterval;
    if (interval !== previous._bridge.healthCheckInterval) {
      for (const { lease } of this._hosted.values()) lease.setHealthCheckInterval(interval);
    }
    for (const { lease } of this._hosted.values()) lease.upstream.retryIfPaused();
  }

  private _specFor(name: string, config: ServerConfig): PoolSpec {
    const base = { name, healthCheckIntervalSec: this._config._bridge.healthCheckInterval, rateLimit: resolveRateLimitConfig(config, this._config._bridge) };
    const reconnect = resolveReconnectInputs(this._config._bridge, config);
    if (isHttpServer(config)) {
      const { key, network, env } = httpUpstreamIdentity(name, config, this._env);
      return { ...base, key, kind: "http", http: { config, credentialStore: this._store, reconnect, network, env } };
    }
    const key = stdioUpstreamKey(config, reconnect, this._env);
    return { ...base, key, kind: "stdio", stdio: { config, childEnv: this._childEnv, credentialStore: this._store, reconnect } };
  }

  private _host(name: string, spec: PoolSpec): void {
    const lease = this._deps.pool.acquire(spec, this, { defaultLimitReached: (config) => this._defaultLimitReached(name, config) });
    const upstream = lease.upstream;
    const announce = (snapshot: UpstreamSnapshot): void => {
      this._index.follow(name, snapshot);
      this._broadcast({ method: "UPSTREAM", params: { ...snapshot, name } });
    };
    const unsubscribe = upstream.subscribe({
      onSnapshot: announce,
      onLog: (level, message, context, stderr) =>
        this._broadcast({
          method: "LOG",
          params: { upstream: name, level, message, ...(Object.keys(context).length > 0 && { context }), ...(stderr !== undefined && { stderr }) },
        }),
    });
    this._hosted.set(name, { key: spec.key, lease, view: hostedView(name, upstream), unsubscribe });
    announce(upstream.snapshot());
  }

  private _unhost(name: string): void {
    const hosted = this._hosted.get(name);
    if (hosted === undefined) return;
    this._hosted.delete(name);
    this._index.remove(name);
    release(hosted);
    this._notifyHostedChanged();
  }

  private _defaultLimitReached(name: string, config: RateLimitConfig): void {
    const message = defaultLimitReachedMessage(name, config);
    this._log.info(message, { server: name });
    this._broadcast({ method: "LOG", params: { upstream: name, level: "info", message } });
  }

  private _notifyHostedChanged(): void {
    for (const listener of [...this._hostedChanged]) listener();
  }

  private _broadcast(notification: InstanceNotification): void {
    for (const attachment of this._attachments) attachment.send(notification);
  }
}

function release(hosted: Hosted): void {
  hosted.unsubscribe();
  hosted.lease.release();
}

/** What `warnAboutConfig` would say about `config`, to warn again only when it changes. */
function configWarnings(config: BridgeConfig): string {
  return JSON.stringify([findRemovedSettings(config), findSelfReferences(config)]);
}
