import type { Logger } from "../logging/index.js";
import { createNoopLogger } from "../logging/index.js";
import type { ToolRegistry } from "../server/tool-registry.js";
import { namespaceTool } from "../server/tool-namespacing.js";
import { defaultClientFactory, type UpstreamClientFactory } from "./client-factory.js";
import type { UpstreamLink } from "./instance-link.js";
import { authorizationPausedMessage, type UpstreamClient } from "./types.js";

export type UpstreamManagerOptions = {
  /** The upstreams to stand in for until the instance says which it has. */
  names: string[];
  toolRegistry: ToolRegistry;
  logger?: Logger;
} & (
  | {
      /** The bridge's link to its daemon instance, which connects every upstream and says which it has. `closeAll` closes it. */
      instanceLink: UpstreamLink;
      /** Clients for tests to use instead of stand-ins on the link. */
      _clientFactory?: UpstreamClientFactory;
    }
  | { instanceLink?: undefined; _clientFactory: UpstreamClientFactory }
);

interface Registered {
  client: UpstreamClient;
  /** Unsubscribe handles for tools/status listeners. */
  unsubscribers: Array<() => void>;
}

/** How connecting one upstream went; `removed` when it was dropped before it got there. */
type ConnectOutcome = { name: string; error?: string; removed?: true };

export interface ConnectAllResult {
  total: number;
  connected: number;
  failed: Array<{ name: string; error: string }>;
}

/**
 * The bridge's stand-ins for its instance's upstreams, one per name: first
 * the names it was given, then the ones the instance reports, as it gains
 * and loses them.
 */
export class UpstreamManager {
  private _names: string[];
  private _toolRegistry: ToolRegistry;
  private _logger: Logger;
  private _clientFactory: UpstreamClientFactory;
  private _clients = new Map<string, Registered>();
  private _instanceLink: UpstreamLink | undefined;
  private _clientsChangedListeners = new Set<() => void>();
  private _unfollow: (() => void) | undefined;

  constructor(options: UpstreamManagerOptions) {
    this._names = options.names;
    this._toolRegistry = options.toolRegistry;
    this._logger = options.logger ?? createNoopLogger();
    this._instanceLink = options.instanceLink;

    this._clientFactory = options.instanceLink === undefined ? options._clientFactory : (options._clientFactory ?? defaultClientFactory(options.instanceLink));
  }

  private async _addClient(name: string): Promise<ConnectOutcome> {
    if (this._clients.has(name)) return { name };
    const log = this._logger.child({ component: "upstream", server: name });
    log.info("connecting");
    return this._connect(this._register(name, log), name, log);
  }

  private _register(name: string, log: Logger): Registered {
    const registered: Registered = { client: this._clientFactory(name), unsubscribers: [] };
    this._clients.set(name, registered);
    this._wireSubscriptions(name, registered, log);
    this._notifyClientsChanged();
    return registered;
  }

  private _wireSubscriptions(name: string, registered: Registered, log: Logger): void {
    const unsubTools = registered.client.onToolsChanged((tools) => {
      const namespaced = tools.map((t) => namespaceTool(name, t));
      this._toolRegistry.setToolsForSource(name, namespaced);
      // An upstream that spams `notifications/tools/list_changed` (some
      // buggy servers do this on every tool call) used to drive this
      // O(n) join on every fire, melting CPU when N is in the hundreds.
      // Info now reports the count only; the full list is debug-level.
      log.info(`${tools.length} tool${tools.length === 1 ? "" : "s"} discovered`);
      log.debug("discovered tools", { tools: namespaced.map((t) => t.name) });
    });

    let pauseLogged = false;
    const unsubStatus = registered.client.onStatusChange((event) => {
      if (event.current === "auth_required" && !pauseLogged) {
        pauseLogged = true;
        log.warn(authorizationPausedMessage(event.error));
        return;
      }
      if (event.current === "connected") pauseLogged = false;
      log.debug(`${event.current}`);
    });

    registered.unsubscribers.push(unsubTools, unsubStatus);
  }

  private async _connect(registered: Registered, name: string, log: Logger): Promise<ConnectOutcome> {
    try {
      await registered.client.connect();
      return { name };
    } catch (err) {
      if (this._clients.get(name) !== registered) return { name, removed: true };
      const message = err instanceof Error ? err.message : String(err);
      log.error(`failed to connect: ${message}`);
      return { name, error: message };
    }
  }

  private async _removeClient(name: string): Promise<void> {
    const registered = this._clients.get(name);
    if (!registered) return;
    this._clients.delete(name);
    this._toolRegistry.removeSource(name);
    for (const unsub of registered.unsubscribers) unsub();
    await registered.client.close().catch(() => {});
  }

  /** Settles once the instance has said which upstreams it has, or at once without one. */
  async upstreamsKnown(): Promise<void> {
    await this._instanceLink?.attachNow().catch(() => {});
  }

  /** Connects every upstream, then follows the instance as it gains and loses them. */
  async connectAll(): Promise<ConnectAllResult> {
    const link = this._instanceLink;
    this._unfollow ??= link?.onUpstreamsChanged(() => this._follow(link));
    if (this._names.length === 0) await link?.attach().catch(() => {});
    const outcomes = (await Promise.all(this._names.map((name) => this._addClient(name)))).filter((outcome) => !outcome.removed);
    const failed = outcomes.filter((o): o is ConnectOutcome & { error: string } => o.error !== undefined);
    return {
      total: outcomes.length,
      connected: outcomes.length - failed.length,
      failed,
    };
  }

  private _follow(link: UpstreamLink): void {
    const names = new Set(link.upstreamNames());
    for (const name of names) {
      if (this._clients.has(name)) continue;
      this._logger.info("adding server", { component: "upstream", server: name });
      void this._addClient(name);
    }
    if (!link.isAttached) return;
    for (const name of [...this._clients.keys()]) {
      if (names.has(name)) continue;
      this._logger.info("removing server", { component: "upstream", server: name });
      void this._removeClient(name);
      this._notifyClientsChanged();
    }
  }

  async closeAll(): Promise<void> {
    this._unfollow?.();
    const all = [...this._clients];
    this._clients.clear();
    for (const [, registered] of all) {
      for (const unsub of registered.unsubscribers) unsub();
    }
    await Promise.all(all.map(([, registered]) => registered.client.close().catch(() => {})));
    for (const [name] of all) this._toolRegistry.removeSource(name);
    await this._instanceLink?.close();
  }

  /** Fires when an upstream is removed or a client is registered under a name; returns an unsubscribe. */
  onClientsChanged(listener: () => void): () => void {
    this._clientsChangedListeners.add(listener);
    return () => this._clientsChangedListeners.delete(listener);
  }

  private _notifyClientsChanged(): void {
    for (const listener of [...this._clientsChangedListeners]) listener();
  }

  getClient(name: string): UpstreamClient | undefined {
    return this._clients.get(name)?.client;
  }
}
