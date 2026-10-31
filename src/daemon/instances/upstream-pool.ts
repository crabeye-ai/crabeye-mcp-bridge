import type { Logger } from "../../logging/index.js";
import { SharedRefreshes } from "../../oauth/shared-refreshes.js";
import { createHttpConnection, defaultCreateHttpClient, type CreateHttpClient, type HttpConnectionSpec } from "./http-connection.js";
import {
  PooledUpstream,
  type ConnectionCloseReason,
  type ConnectionDeps,
  type HttpPoolConnection,
  type PoolConnection,
  type RunningChild,
} from "./pooled-upstream.js";
import { createStdioConnection, type LegacyServers, type StdioConnectionOptions, type StdioConnectionSpec } from "./stdio-connection.js";

/** At most how long a closing connection's refreshes may delay a stopping manager while they save their tokens. */
export const STOP_SAVE_WAIT_MS = 2_000;

export type PoolSpec = {
  key: string;
  /** The name the owner gives the upstream. */
  name: string;
  healthCheckIntervalSec: number;
} & ({ kind: "stdio"; stdio: StdioConnectionSpec } | { kind: "http"; http: HttpConnectionSpec });

/** What an owner may do with a connection it holds a lease on. */
export type SharedUpstream = Pick<PooledUpstream, "status" | "snapshot" | "callTool" | "retry" | "retryIfPaused" | "subscribe">;

export interface Lease {
  readonly upstream: SharedUpstream;
  /** This owner's health-check interval, which applies while it is the longest-standing owner. */
  setHealthCheckInterval(intervalSec: number): void;
  /** Idempotent. The connection closes once its last lease is released, after `graceMs` for a STDIO server. */
  release(): void;
}

export interface UpstreamPoolOptions {
  logger: Logger;
  createHttpClient?: CreateHttpClient;
  stdio: StdioConnectionOptions & {
    /** How long a STDIO server outlives its last lease. */
    graceMs: number;
  };
  /** Called whenever the pool has nothing left open or closing. */
  onEmpty?: () => void;
}

/** A STDIO server process one of the pool's connections runs. */
export interface PooledChild extends RunningChild {
  key: string;
  serverName: string;
  instances: number;
}

interface Entry {
  upstream: PooledUpstream;
  keepMs: number;
  graceTimer?: NodeJS.Timeout;
  stopWatching?: () => void;
}

/**
 * One connection per upstream key across every instance in the daemon:
 * HTTP and SSE connections refresh tokens once among them, and a STDIO server
 * runs once whatever names and instances use it.
 */
export class UpstreamPool {
  private readonly _entries = new Map<string, Entry>();
  private readonly _closing = new Map<PooledUpstream, Promise<void>>();
  private readonly _refreshes = new SharedRefreshes();
  private readonly _legacyServers: LegacyServers = new Set();
  private readonly _opts: UpstreamPoolOptions;

  constructor(options: UpstreamPoolOptions) {
    this._opts = options;
  }

  get isEmpty(): boolean {
    return this._entries.size === 0 && this._closing.size === 0;
  }

  /**
   * Each lease is an owner of its connection: the longest-standing owner's
   * health-check interval applies, then the next one's. `instance` groups the
   * leases one instance holds under different names.
   */
  acquire(spec: PoolSpec, instance: object = {}): Lease {
    const entry = this._entryFor(spec);
    this._keep(entry);
    const { upstream } = entry;
    const owner = {};
    upstream.addOwner(owner, instance, spec.name, spec.healthCheckIntervalSec);
    let released = false;
    return {
      upstream,
      setHealthCheckInterval: (intervalSec) => upstream.setHealthCheckInterval(owner, intervalSec),
      release: () => {
        if (released) return;
        released = true;
        if (upstream.removeOwner(owner) === 0) this._closeUnused(entry);
      },
    };
  }

  upstreams(): PooledUpstream[] {
    return [...this._entries.values()].map((entry) => entry.upstream);
  }

  children(): PooledChild[] {
    return this.upstreams().flatMap((upstream) => {
      const child = upstream.connection.type === "stdio" ? upstream.connection.child() : undefined;
      return child === undefined ? [] : [{ ...child, key: upstream.key, serverName: upstream.name, instances: upstream.instanceCount }];
    });
  }

  /** Starts the STDIO server whose key is `key` again; returns how many were. */
  restart(key: string): number {
    const entry = this._entries.get(key);
    return entry?.upstream.restart() ? 1 : 0;
  }

  /**
   * Connects every connection to an upstream named `name` again after its
   * stored credentials changed, and keeps the ones still closing from changing
   * them; resolves with how many tried to connect again, once they have.
   */
  async credentialsChanged(name: string): Promise<number> {
    for (const connection of httpConnections([...this._closing.keys()], name)) connection.retireAuth();
    const named = httpConnections(this.upstreams(), name);
    await Promise.all(named.map((connection) => connection.credentialsChanged()));
    return named.length;
  }

  /** Closes every connection, waiting for their refreshes to save their tokens up to `STOP_SAVE_WAIT_MS`, and never longer than `maxSaveWaitMs`. */
  async close(maxSaveWaitMs: number): Promise<void> {
    for (const entry of this._entries.values()) {
      this._keep(entry);
      this._track(entry.upstream, "shutdown");
    }
    this._entries.clear();
    const saveWaitMs = Math.min(STOP_SAVE_WAIT_MS, maxSaveWaitMs);
    for (const connection of httpConnections([...this._closing.keys()])) connection.limitSaveWait(saveWaitMs);
    while (this._closing.size > 0) await Promise.allSettled([...this._closing.values()]);
  }

  private _entryFor(spec: PoolSpec): Entry {
    const existing = this._entries.get(spec.key);
    if (existing !== undefined) return existing;
    const upstream = new PooledUpstream(
      { key: spec.key, name: spec.name, healthCheckIntervalSec: spec.healthCheckIntervalSec, connect: (deps) => this._connect(spec, deps) },
      this._opts.logger,
    );
    const entry: Entry = { upstream, keepMs: spec.kind === "stdio" ? this._opts.stdio.graceMs : 0 };
    this._entries.set(spec.key, entry);
    return entry;
  }

  private _connect(spec: PoolSpec, deps: ConnectionDeps): PoolConnection {
    if (spec.kind === "stdio") {
      return createStdioConnection(spec.stdio, { ...deps, daemonLogger: this._opts.logger, legacyServers: this._legacyServers }, this._opts.stdio);
    }
    return createHttpConnection(spec.http, { ...deps, refreshes: this._refreshes, createClient: this._opts.createHttpClient ?? defaultCreateHttpClient });
  }

  /** Stops counting down to closing a connection an owner took again. */
  private _keep(entry: Entry): void {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = undefined;
    entry.stopWatching?.();
    entry.stopWatching = undefined;
  }

  /** Closes an unused connection after its `keepMs`, or as soon as its server goes away, rather than starting it again for nobody. */
  private _closeUnused(entry: Entry): void {
    if (entry.keepMs <= 0 || entry.upstream.status === "disconnected") {
      this._closeEntry(entry);
      return;
    }
    entry.graceTimer = setTimeout(() => this._closeEntry(entry), entry.keepMs);
    entry.graceTimer.unref();
    entry.stopWatching = entry.upstream.subscribe({
      onSnapshot: (snapshot) => {
        if (snapshot.status === "disconnected") this._closeEntry(entry);
      },
      onLog: () => {},
    });
  }

  private _closeEntry(entry: Entry): void {
    this._keep(entry);
    if (entry.upstream.ownerCount > 0 || this._entries.get(entry.upstream.key) !== entry) return;
    this._entries.delete(entry.upstream.key);
    this._track(entry.upstream, "idle");
  }

  private _track(upstream: PooledUpstream, reason: ConnectionCloseReason): void {
    const closing = upstream.close(reason);
    this._closing.set(upstream, closing);
    void closing.finally(() => {
      this._closing.delete(upstream);
      if (this.isEmpty) this._opts.onEmpty?.();
    });
  }
}

function httpConnections(upstreams: PooledUpstream[], name?: string): HttpPoolConnection[] {
  return upstreams.flatMap(({ connection, name: upstreamName }) =>
    connection.type === "stdio" || (name !== undefined && upstreamName !== name) ? [] : [connection],
  );
}
