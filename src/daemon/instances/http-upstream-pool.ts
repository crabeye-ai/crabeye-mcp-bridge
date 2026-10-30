import type { CallToolResult } from "@modelcontextprotocol/client";
import type { HttpServerConfig } from "../../config/schema.js";
import type { CredentialStore } from "../../credentials/credential-store.js";
import type { Logger, LogLevel } from "../../logging/index.js";
import { PendingSaves } from "../../oauth/pending-saves.js";
import { SharedRefreshes } from "../../oauth/shared-refreshes.js";
import { HealthChecks } from "../../upstream/health-checks.js";
import { HttpUpstreamClient } from "../../upstream/http-client.js";
import { canonicalize, type UpstreamReconnectInputs } from "../../upstream/upstream-hash.js";
import { authorizationPausedMessage, ConnectionSupersededError, type ConnectionStatus, type StatusChangeEvent, type UpstreamClient } from "../../upstream/types.js";
import type { NetworkSettings } from "../instance-env.js";
import { capStderrLine, STDERR_LINE_MAX_CHARS, type UpstreamLogContext, type UpstreamLogLevel, type UpstreamSnapshot } from "../protocol.js";
import { networkFetch, type NetworkFetch } from "./network.js";

export interface PooledUpstreamSpec {
  key: string;
  name: string;
  config: HttpServerConfig;
  credentialStore: CredentialStore;
  reconnect: UpstreamReconnectInputs;
  healthCheckIntervalSec: number;
  network: NetworkSettings;
  /** The client variables the connection reads, all of them part of `key`. */
  env: Record<string, string>;
}

export interface PooledUpstreamListener {
  onSnapshot(snapshot: UpstreamSnapshot): void;
  onLog(level: UpstreamLogLevel, message: string, context: UpstreamLogContext): void;
}

/** A pooled connection's client, which can be told its OAuth provider must stop changing what is stored. */
export type PoolClient = UpstreamClient & { retireAuth(): void };

/** At most how long a closing connection's refreshes may delay a stopping manager while they save their tokens. */
export const STOP_SAVE_WAIT_MS = 2_000;

export type CreateHttpClient = (
  name: string,
  config: HttpServerConfig,
  deps: {
    logger: Logger;
    credentialStore: CredentialStore;
    reconnect: UpstreamReconnectInputs;
    fetch: typeof fetch;
    env: Record<string, string>;
    refreshes: SharedRefreshes;
    pendingSaves: PendingSaves;
  },
) => PoolClient;

/** What an owner may do with a connection it holds a lease on. */
export type SharedUpstream = Pick<PooledUpstream, "name" | "status" | "snapshot" | "callTool" | "retry" | "retryIfPaused" | "subscribe">;

export interface Lease {
  readonly upstream: SharedUpstream;
  /** This owner's health-check interval, which applies while it is the longest-standing owner. */
  setHealthCheckInterval(intervalSec: number): void;
  /** Idempotent. The connection closes when its last lease is released. */
  release(): void;
}

export interface HttpUpstreamPoolOptions {
  logger: Logger;
  createClient?: CreateHttpClient;
}

const defaultCreateClient: CreateHttpClient = (name, config, deps) =>
  new HttpUpstreamClient({
    name,
    config,
    logger: deps.logger,
    credentialStore: deps.credentialStore,
    fetch: deps.fetch,
    env: deps.env,
    refreshes: deps.refreshes,
    pendingSaves: deps.pendingSaves,
    ...deps.reconnect,
  });

/** One connection per upstream key across every instance in the daemon, refreshing tokens once among them. */
export class HttpUpstreamPool {
  private readonly _upstreams = new Map<string, PooledUpstream>();
  private readonly _closing = new Map<PooledUpstream, Promise<void>>();
  private readonly _refreshes = new SharedRefreshes();
  private readonly _logger: Logger;
  private readonly _createClient: CreateHttpClient;

  constructor(options: HttpUpstreamPoolOptions) {
    this._logger = options.logger;
    this._createClient = options.createClient ?? defaultCreateClient;
  }

  /** Each lease is an owner of its connection: the longest-standing owner's health-check interval applies, then the next one's. */
  acquire(spec: PooledUpstreamSpec): Lease {
    const upstream = this._upstreamFor(spec);
    const owner = {};
    upstream.addOwner(owner, spec.healthCheckIntervalSec);
    let released = false;
    return {
      upstream,
      setHealthCheckInterval: (intervalSec) => upstream.setHealthCheckInterval(owner, intervalSec),
      release: () => {
        if (released) return;
        released = true;
        if (upstream.removeOwner(owner) > 0) return;
        if (this._upstreams.get(upstream.key) === upstream) this._upstreams.delete(upstream.key);
        this._track(upstream);
      },
    };
  }

  upstreams(): PooledUpstream[] {
    return [...this._upstreams.values()];
  }

  /**
   * Connects every connection to an upstream named `name` again after its
   * stored credentials changed, and keeps the ones still closing from changing
   * them; resolves with how many tried to connect again, once they have.
   */
  async credentialsChanged(name: string): Promise<number> {
    for (const closing of this._closing.keys()) if (closing.name === name) closing.retireAuth();
    const named = this.upstreams().filter((upstream) => upstream.name === name);
    await Promise.all(named.map((upstream) => upstream.credentialsChanged()));
    return named.length;
  }

  /** Closes every connection, waiting for their refreshes to save their tokens up to `STOP_SAVE_WAIT_MS`, and never longer than `maxSaveWaitMs`. */
  async close(maxSaveWaitMs: number): Promise<void> {
    for (const upstream of this._upstreams.values()) this._track(upstream);
    this._upstreams.clear();
    const saveWaitMs = Math.min(STOP_SAVE_WAIT_MS, maxSaveWaitMs);
    for (const closing of this._closing.keys()) closing.limitSaveWait(saveWaitMs);
    while (this._closing.size > 0) await Promise.allSettled([...this._closing.values()]);
  }

  private _upstreamFor(spec: PooledUpstreamSpec): PooledUpstream {
    const existing = this._upstreams.get(spec.key);
    if (existing !== undefined) return existing;
    const created = new PooledUpstream(spec, this._logger, this._createClient, this._refreshes);
    this._upstreams.set(spec.key, created);
    return created;
  }

  private _track(upstream: PooledUpstream): void {
    const closing = upstream.close();
    this._closing.set(upstream, closing);
    void closing.finally(() => this._closing.delete(upstream));
  }
}

interface Owner {
  owner: object;
  healthCheckIntervalSec: number;
}

/** A shared connection, its health checks and the bridges' view of it. */
export class PooledUpstream {
  readonly key: string;
  readonly name: string;
  private readonly _client: PoolClient;
  private readonly _network: NetworkFetch;
  private readonly _pendingSaves = new PendingSaves();
  private readonly _stopWaiting = new AbortController();
  private readonly _log: Logger;
  private readonly _health: HealthChecks;
  private readonly _owners: Owner[] = [];
  private readonly _listeners = new Set<PooledUpstreamListener>();
  private readonly _unsubscribers: Array<() => void>;
  private _lastError: string | undefined;
  private _published: { snapshot: UpstreamSnapshot; toolsRef: unknown; toolsText: string } | undefined;
  private _pauseLogged = false;

  constructor(spec: PooledUpstreamSpec, daemonLogger: Logger, createClient: CreateHttpClient, refreshes: SharedRefreshes) {
    this.key = spec.key;
    this.name = spec.name;
    this._log = daemonLogger.child({ component: "upstream", server: spec.name });
    const reporting = new ReportingLogger(this._log, (level, message, context) => this._report(level, message, context));
    this._network = networkFetch(spec.network, reporting);
    this._client = createClient(spec.name, spec.config, {
      logger: reporting,
      credentialStore: spec.credentialStore,
      reconnect: spec.reconnect,
      fetch: this._network.fetch,
      env: spec.env,
      refreshes,
      pendingSaves: this._pendingSaves,
    });
    this._health = new HealthChecks({ intervalSec: spec.healthCheckIntervalSec, logger: reporting });
    this._health.add(this._client, spec.name);
    this._unsubscribers = [
      this._client.onStatusChange((event) => this._onStatusChange(event)),
      this._client.onToolsChanged(() => this._publish()),
    ];
    this._log.info(`connecting (${spec.config.type})`);
    this._client.connect().catch((err: unknown) => {
      if (!(err instanceof ConnectionSupersededError)) this._log.warn(`failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    });
    this._health.start();
  }

  get status(): ConnectionStatus {
    return this._client.status;
  }

  /** How many instances hold this connection. */
  get ownerCount(): number {
    return this._owners.length;
  }

  snapshot(): UpstreamSnapshot {
    const { status, tools, instructions } = this._client;
    const connected = status === "connected";
    return {
      name: this.name,
      status,
      ...(!connected && this._lastError !== undefined && { error: this._lastError }),
      tools: connected ? [...tools] : [],
      ...(connected && instructions !== undefined && { instructions }),
    };
  }

  callTool(params: { name: string; arguments?: Record<string, unknown> }, options: { signal: AbortSignal }): Promise<CallToolResult> {
    return this._client.callTool(params, options);
  }

  /** Tries to connect now unless it just tried, then reports where it stands. */
  async retry(): Promise<UpstreamSnapshot> {
    await this._client.retryNow();
    return this.snapshot();
  }

  retryIfPaused(): void {
    if (this._client.status === "auth_required") void this._client.retryNow();
  }

  /** Connects again, even when connected, so stored credentials that changed apply at once; settles once it has tried. */
  credentialsChanged(): Promise<void> {
    this.retireAuth();
    return this._client.reconnect().catch(() => {});
  }

  /** Stops waiting for refreshes to save after `ms`, if the connection is still closing. */
  limitSaveWait(ms: number): void {
    setTimeout(() => this._stopWaiting.abort(), ms).unref();
  }

  /** Keeps the connection's OAuth provider from changing stored credentials any more. */
  retireAuth(): void {
    this._client.retireAuth();
  }

  subscribe(listener: PooledUpstreamListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  addOwner(owner: object, healthCheckIntervalSec: number): void {
    this._owners.push({ owner, healthCheckIntervalSec });
  }

  /** Returns how many owners are left. */
  removeOwner(owner: object): number {
    const at = this._owners.findIndex((entry) => entry.owner === owner);
    if (at < 0) return this._owners.length;
    const [removed] = this._owners.splice(at, 1);
    const next = this._owners[0];
    if (at === 0 && next !== undefined && next.healthCheckIntervalSec !== removed!.healthCheckIntervalSec) {
      this._health.restart(next.healthCheckIntervalSec);
    }
    return this._owners.length;
  }

  setHealthCheckInterval(owner: object, intervalSec: number): void {
    const entry = this._owners.find((candidate) => candidate.owner === owner);
    if (entry === undefined) return;
    entry.healthCheckIntervalSec = intervalSec;
    if (entry === this._owners[0]) this._health.restart(intervalSec);
  }

  /**
   * Closes the client at once, then keeps the network open until its
   * refreshes have saved their tokens, for as long as a refresh may take or
   * until `limitSaveWait` cuts the wait: the authorization server may already
   * have redeemed the refresh token, and closing the network would lose the
   * new one. Its OAuth providers are then retired, so a refresh one of them
   * joins afterwards can't put back credentials removed since.
   */
  async close(): Promise<void> {
    this._health.stop();
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._listeners.clear();
    await this._client.close().catch(() => {});
    await this._pendingSaves.settled(this._stopWaiting.signal);
    this._client.retireAuth();
    await this._network.close();
  }

  private _onStatusChange(event: StatusChangeEvent): void {
    if (event.current === "connected") {
      this._lastError = undefined;
      this._pauseLogged = false;
    } else if (event.error !== undefined) {
      this._lastError = event.error.message;
    }
    if (event.current === "auth_required" && !this._pauseLogged) {
      this._pauseLogged = true;
      this._log.warn(authorizationPausedMessage(event.error));
    }
    this._publish();
  }

  private _publish(): void {
    const snapshot = this.snapshot();
    if (!this._recordIfChanged(snapshot)) return;
    for (const listener of [...this._listeners]) listener.onSnapshot(snapshot);
  }

  /** Remembers `snapshot` as the last one published; true when it differs from that one. */
  private _recordIfChanged(snapshot: UpstreamSnapshot): boolean {
    const previous = this._published;
    const toolsRef = snapshot.status === "connected" ? this._client.tools : undefined;
    const toolsText = previous !== undefined && previous.toolsRef === toolsRef ? previous.toolsText : canonicalize(snapshot.tools);
    this._published = { snapshot, toolsRef, toolsText };
    return (
      previous === undefined ||
      previous.snapshot.status !== snapshot.status ||
      previous.snapshot.error !== snapshot.error ||
      previous.snapshot.instructions !== snapshot.instructions ||
      previous.toolsText !== toolsText
    );
  }

  private _report(level: UpstreamLogLevel, message: string, context: UpstreamLogContext): void {
    for (const listener of [...this._listeners]) listener.onLog(level, message, context);
  }
}

/** Logs to `inner` and also hands warnings and errors to `report`, with the context that is safe to send. */
class ReportingLogger implements Logger {
  constructor(
    private readonly _inner: Logger,
    private readonly _report: (level: UpstreamLogLevel, message: string, context: UpstreamLogContext) => void,
    private readonly _defaults: Record<string, unknown> = {},
  ) {}

  debug(message: string, context?: Record<string, unknown>): void {
    this._inner.debug(message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this._inner.info(message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this._inner.warn(message, context);
    this._forward("warn", message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this._inner.error(message, context);
    this._forward("error", message, context);
  }

  child(defaultContext: Record<string, unknown>): Logger {
    return new ReportingLogger(this._inner.child(defaultContext), this._report, { ...this._defaults, ...defaultContext });
  }

  setLevel(level: LogLevel): void {
    this._inner.setLevel(level);
  }

  private _forward(level: UpstreamLogLevel, message: string, context: Record<string, unknown> | undefined): void {
    this._report(level, capStderrLine(message, STDERR_LINE_MAX_CHARS), reportable({ ...this._defaults, ...context }));
  }
}

function reportable(context: Record<string, unknown>): UpstreamLogContext {
  const out: UpstreamLogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (key === "server") continue;
    if (typeof value === "string") out[key] = capStderrLine(value, STDERR_LINE_MAX_CHARS);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}
