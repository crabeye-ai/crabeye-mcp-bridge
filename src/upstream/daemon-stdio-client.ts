import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { StdioServerConfig } from "../config/schema.js";
import {
  DaemonClient,
  ensureDaemonRunning,
  getDaemonSocketPath,
  netTransport,
  type DaemonNotification,
} from "../daemon/index.js";
import { BaseUpstreamClient } from "./base-client.js";
import type { BaseUpstreamClientOptions } from "./base-client.js";

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
      socketPath: this._socketPath,
      ensureDaemon: this._ensureDaemon,
    });
  }
}

interface DaemonStdioTransportOpts {
  serverName: string;
  command: string;
  args: string[];
  resolvedEnv: Record<string, string>;
  cwd: string;
  socketPath: string;
  ensureDaemon: () => Promise<void>;
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
  private daemonClient: DaemonClient;
  private opened = false;
  private closing = false;
  private unsubscribeClose: (() => void) | undefined;

  constructor(opts: DaemonStdioTransportOpts) {
    this.opts = opts;
    this._daemonSessionId = randomUUID();
    this.daemonClient = new DaemonClient({
      socketPath: opts.socketPath,
      transport: netTransport,
      rpcTimeoutMs: 10_000,
      connectTimeoutMs: 5_000,
      onNotification: (notif) => this._onNotification(notif),
    });
  }

  async start(): Promise<void> {
    await this.opts.ensureDaemon();
    await this.daemonClient.connect();
    this.unsubscribeClose = this.daemonClient.onClose(() => this._onSocketClose());
    try {
      await this.daemonClient.call("OPEN", {
        sessionId: this._daemonSessionId,
        spec: {
          serverName: this.opts.serverName,
          command: this.opts.command,
          args: this.opts.args,
          resolvedEnv: this.opts.resolvedEnv,
          cwd: this.opts.cwd,
        },
      });
    } catch (err) {
      // OPEN failure (spawn failed, validation rejected, RPC timeout): close
      // the socket and drop the listener so we don't leak a connection +
      // listener for every retry.
      this.unsubscribeClose?.();
      this.unsubscribeClose = undefined;
      this.daemonClient.close();
      throw err;
    }
    this.opened = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closing) throw new Error("daemon transport is closed");
    const ok = this.daemonClient.sendNotification("RPC", {
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
    this.unsubscribeClose?.();
    if (this.opened) {
      try {
        await this.daemonClient.call("CLOSE", { sessionId: this._daemonSessionId });
      } catch {
        // Daemon may already be gone, or socket killed mid-call. Either way
        // we're tearing down anyway.
      }
      this.opened = false;
    }
    this.daemonClient.close();
    this.onclose?.();
  }

  private _onNotification(notif: DaemonNotification): void {
    if (notif.method !== "RPC") return;
    const params = notif.params as { sessionId?: string; payload?: unknown } | undefined;
    if (!params || params.sessionId !== this._daemonSessionId) return;
    if (params.payload === undefined) return;
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
