import { isAbsolute } from "node:path";
import { SdkError, SdkErrorCode, type CallToolResult, type ConnectOptions, type Transport } from "@modelcontextprotocol/client";
import type { StdioServerConfig } from "../../config/schema.js";
import type { CredentialStore } from "../../credentials/credential-store.js";
import { resolveCredentialTemplates } from "../../credentials/resolve-templates.js";
import { BaseUpstreamClient, type BaseUpstreamClientOptions } from "../../upstream/base-client.js";
import { ConnectionSupersededError } from "../../upstream/types.js";
import { isSpawnableEntry } from "../instance-env.js";
import { spawnEnv } from "./child-env.js";
import { ChildTransport, type ChildEvents, type ChildRestartReason, type ChildStopReason, type RunningProcess, type SpawnChild } from "./child-transport.js";

export interface StdioUpstreamClientOptions extends BaseUpstreamClientOptions {
  config: StdioServerConfig;
  /** The environment of the bridge that created the instance (see `childEnvFrom`). */
  childEnv: Record<string, string>;
  /** Resolves the server's `${credential:...}` values each time it starts. */
  credentialStore: CredentialStore;
  killGraceMs?: number;
  stderrDrainMs?: number;
  events: ChildEvents;
  onStderr(line: string): void;
  spawnChild?: SpawnChild;
  /** Connects as to a legacy server from the start: one already found not to answer the protocol version question. */
  knownLegacy?: boolean;
  /** Called once a server that didn't answer the protocol version question has connected as a legacy one. */
  onLegacy?(): void;
}

/** How the next connect starts the server: asking its protocol versions, as a legacy one after the question failed, or as one known to be legacy. */
type EraMode = "ask" | "legacy fallback" | "legacy";

/**
 * The daemon's MCP client for one STDIO server. Each connect starts the
 * server and negotiates its protocol era before any request; the server
 * ending makes it start again after the backoff.
 */
export class StdioUpstreamClient extends BaseUpstreamClient {
  private readonly _opts: StdioUpstreamClientOptions;
  private _env: Record<string, string> = {};
  private _mode: EraMode;

  constructor(options: StdioUpstreamClientOptions) {
    super(options);
    this._opts = options;
    this._mode = options.knownLegacy ? "legacy" : "ask";
  }

  /** The server process of the current connection, unless it has ended. */
  get child(): RunningProcess | undefined {
    const transport = this._childTransport();
    return transport?.endedBecause === undefined ? transport?.child : undefined;
  }

  /** A call fails saying why the server went away, when it went away during the call. */
  override async callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { signal?: AbortSignal },
  ): Promise<CallToolResult> {
    const transport = this._childTransport();
    try {
      return await super.callTool(params, options);
    } catch (err) {
      const endedBecause = transport?.endedBecause;
      if (endedBecause !== undefined && err instanceof SdkError && err.code === SdkErrorCode.ConnectionClosed) throw new Error(endedBecause);
      throw err;
    }
  }

  /** Starts the server again, saying why. */
  restart(reason: ChildRestartReason): Promise<void> {
    this._childTransport()?.stopFor(reason);
    return this.reconnect();
  }

  /** Stops the server for good. */
  stop(reason: ChildStopReason): Promise<void> {
    this._childTransport()?.stopFor(reason);
    return this.close();
  }

  /**
   * A server that gives no answer to the protocol version question, or quits
   * on it, is connected to again at once as a legacy one; if that fails too,
   * the next attempt asks again. A connect replaced by another keeps what the
   * question found.
   */
  protected override _retryConnectAfter(err: unknown, transport: Transport | undefined): boolean {
    if (err instanceof ConnectionSupersededError) return false;
    if (this._mode === "legacy fallback") {
      this._mode = "ask";
      return false;
    }
    if (this._mode === "legacy" || !(transport instanceof ChildTransport) || !unansweredProbe(err, transport)) return false;
    this._mode = "legacy fallback";
    this._logger.info("no answer to the protocol version question; connecting as a legacy server");
    return true;
  }

  protected override _connectOptions(): ConnectOptions | undefined {
    return this._mode === "ask" ? undefined : { prior: { kind: "legacy" } };
  }

  protected override _afterConnect(transport: Transport): void {
    if (transport instanceof ChildTransport) transport.markConnected();
    if (this._mode !== "legacy fallback") return;
    this._mode = "legacy";
    this._opts.onLegacy?.();
  }

  protected override async _prepareConnect(): Promise<void> {
    checkSpawnable(this._opts.config);
    const serverEnv = await resolveCredentialTemplates(this._opts.config.env ?? {}, this._opts.credentialStore);
    for (const [name, value] of Object.entries(serverEnv)) {
      if (!isSpawnableEntry(name, value)) throw new Error(`env variable ${JSON.stringify(name)} can't be passed to a process: its name is empty, has "=" or a NUL character, or its value has a NUL character`);
    }
    this._env = spawnEnv(this._opts.childEnv, serverEnv);
  }

  protected _buildTransport(): Transport {
    const { config } = this._opts;
    return new ChildTransport({
      command: config.command,
      args: config.args ?? [],
      env: this._env,
      cwd: config.cwd,
      killGraceMs: this._opts.killGraceMs,
      stderrDrainMs: this._opts.stderrDrainMs,
      events: this._opts.events,
      onStderr: (line) => this._opts.onStderr(line),
      spawnChild: this._opts.spawnChild,
    });
  }

  private _childTransport(): ChildTransport | undefined {
    return this._currentTransport instanceof ChildTransport ? this._currentTransport : undefined;
  }
}

/** The server quit after the protocol version question without answering anything else, or let the question time out. */
function unansweredProbe(err: unknown, transport: ChildTransport): boolean {
  return transport.quitOnProbe || (transport.probing && err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout);
}

function checkSpawnable({ command, args = [], cwd }: StdioServerConfig): void {
  if (command.includes("\0")) throw new Error("the command has a NUL character");
  const withNul = args.findIndex((arg) => arg.includes("\0"));
  if (withNul >= 0) throw new Error(`argument ${withNul + 1} has a NUL character`);
  if (cwd?.includes("\0")) throw new Error("cwd has a NUL character");
  if (cwd !== undefined && !isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
}
