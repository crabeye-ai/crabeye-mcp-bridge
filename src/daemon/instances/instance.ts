import { ConfigWatcher } from "../../config/config-watcher.js";
import { diffServers } from "../../config/config-diff.js";
import { isHttpServer, resolveUpstreams, type BridgeConfig, type HttpServerConfig } from "../../config/schema.js";
import type { CredentialStore } from "../../credentials/credential-store.js";
import type { Logger } from "../../logging/index.js";
import { resolveReconnectInputs } from "../../upstream/upstream-hash.js";
import type {
  InstanceSource,
  StatusInstance,
  UpstreamLogParams,
  UpstreamRemovedParams,
  UpstreamSnapshot,
} from "../protocol.js";
import type { HttpUpstreamPool, Lease, SharedUpstream } from "./http-upstream-pool.js";
import { httpUpstreamIdentity } from "./identity.js";

export interface LoadedConfig {
  config: BridgeConfig;
  watchPaths: string[];
}

export interface InstanceDeps {
  pool: HttpUpstreamPool;
  logger: Logger;
  loadConfig: (source: InstanceSource) => Promise<LoadedConfig>;
  createCredentialStore: (env: Record<string, string>) => CredentialStore;
  watchDebounceMs?: number;
}

export type InstanceNotification =
  | { method: "UPSTREAM"; params: UpstreamSnapshot }
  | { method: "UPSTREAM_REMOVED"; params: UpstreamRemovedParams }
  | { method: "LOG"; params: UpstreamLogParams };

/** Where an instance sends what its bridges need to hear: one per attached socket. */
export interface InstanceAttachment {
  send(notification: InstanceNotification): void;
}

interface Hosted {
  lease: Lease;
  unsubscribe: () => void;
}

/**
 * The daemon's copy of one config, shared by every bridge that would load it.
 * Holds a pooled connection for each HTTP and SSE server and follows edits
 * to the files it loaded.
 */
export class Instance {
  readonly source: InstanceSource;
  private readonly _env: Record<string, string>;
  private readonly _deps: InstanceDeps;
  private readonly _store: CredentialStore;
  private readonly _log: Logger;
  private readonly _attachments = new Set<InstanceAttachment>();
  private readonly _hosted = new Map<string, Hosted>();
  private _config: BridgeConfig;
  private _watcher: ConfigWatcher | undefined;
  private _watchPaths: readonly string[] = [];
  private _applying: Promise<void> = Promise.resolve();
  private _reloadRunning: Promise<void> | undefined;
  private _reloadQueued: Promise<void> | undefined;
  private _closed = false;

  private constructor(source: InstanceSource, env: Record<string, string>, loaded: LoadedConfig, deps: InstanceDeps) {
    this.source = source;
    this._env = env;
    this._deps = deps;
    this._config = loaded.config;
    this._log = deps.logger.child({ component: "instance" });
    this._store = deps.createCredentialStore(env);
    for (const [name, config] of Object.entries(hostedServers(loaded.config))) this._host(name, config);
    this._watch(loaded.watchPaths);
  }

  /** Loads the config for `source`; rejects with the loader's error when it can't. */
  static async open(source: InstanceSource, env: Record<string, string>, deps: InstanceDeps): Promise<Instance> {
    return new Instance(source, env, await deps.loadConfig(source), deps);
  }

  get attachmentCount(): number {
    return this._attachments.size;
  }

  /** Sends the attachment a snapshot of every hosted upstream, then keeps it up to date. */
  attach(attachment: InstanceAttachment): void {
    this._attachments.add(attachment);
    for (const { lease } of this._hosted.values()) attachment.send({ method: "UPSTREAM", params: lease.upstream.snapshot() });
  }

  upstreamNames(): string[] {
    return [...this._hosted.keys()];
  }

  detach(attachment: InstanceAttachment): void {
    this._attachments.delete(attachment);
  }

  /** The hosted upstream named `name`, reloading the config first when there is none. */
  async upstream(name: string): Promise<SharedUpstream | undefined> {
    const hosted = this._hosted.get(name);
    if (hosted !== undefined) return hosted.lease.upstream;
    await this.reload();
    return this._hosted.get(name)?.lease.upstream;
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
  }

  private _watch(watchPaths: string[]): void {
    this._watchPaths = watchPaths;
    this._watcher = new ConfigWatcher({
      configPaths: watchPaths,
      loadConfig: async () => (await this._deps.loadConfig(this.source)).config,
      logger: this._log,
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
      loaded = await this._deps.loadConfig(this.source);
    } catch (err) {
      this._log.warn("failed to reload config", { error: err instanceof Error ? err.message : String(err) });
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
    const diff = diffServers(hostedServers(previous), hostedServers(next));
    for (const name of diff.removed) {
      this._log.info("removing server", { server: name });
      this._unhost(name);
      this._broadcast({ method: "UPSTREAM_REMOVED", params: { upstream: name } });
    }
    for (const { name, config } of diff.reconnect) {
      this._log.info("reconnecting server", { server: name });
      this._unhost(name);
      this._host(name, config);
    }
    for (const { name, config } of diff.added) {
      this._log.info("adding server", { server: name });
      this._host(name, config);
    }
    const interval = next._bridge.healthCheckInterval;
    if (interval !== previous._bridge.healthCheckInterval) {
      for (const { lease } of this._hosted.values()) lease.setHealthCheckInterval(interval);
    }
    for (const { lease } of this._hosted.values()) lease.upstream.retryIfPaused();
  }

  private _host(name: string, config: HttpServerConfig): void {
    const bridgeConfig = this._config;
    const { key, network, env } = httpUpstreamIdentity(name, config, this._env);
    const lease = this._deps.pool.acquire({
      key,
      name,
      config,
      credentialStore: this._store,
      reconnect: resolveReconnectInputs(bridgeConfig._bridge, config),
      healthCheckIntervalSec: bridgeConfig._bridge.healthCheckInterval,
      network,
      env,
    });
    const unsubscribe = lease.upstream.subscribe({
      onSnapshot: (snapshot) => this._broadcast({ method: "UPSTREAM", params: snapshot }),
      onLog: (level, message, context) =>
        this._broadcast({
          method: "LOG",
          params: { upstream: name, level, message, ...(Object.keys(context).length > 0 && { context }) },
        }),
    });
    this._hosted.set(name, { lease, unsubscribe });
    this._broadcast({ method: "UPSTREAM", params: lease.upstream.snapshot() });
  }

  private _unhost(name: string): void {
    const hosted = this._hosted.get(name);
    if (hosted === undefined) return;
    this._hosted.delete(name);
    hosted.unsubscribe();
    hosted.lease.release();
  }

  private _broadcast(notification: InstanceNotification): void {
    for (const attachment of this._attachments) attachment.send(notification);
  }
}

function hostedServers(config: BridgeConfig): Record<string, HttpServerConfig> {
  const hosted: Record<string, HttpServerConfig> = {};
  for (const [name, server] of Object.entries(resolveUpstreams(config))) {
    if (isHttpServer(server)) hosted[name] = server;
  }
  return hosted;
}
