import type { CallToolResult } from "@modelcontextprotocol/client";
import type { Logger, LogLevel } from "../../logging/index.js";
import { HealthChecks } from "../../upstream/health-checks.js";
import { canonicalize } from "../../upstream/upstream-hash.js";
import { authorizationPausedMessage, ConnectionSupersededError, type ConnectionStatus, type StatusChangeEvent, type UpstreamClient } from "../../upstream/types.js";
import type { ChildRestartReason } from "./child-transport.js";
import {
  capStderrLine,
  STDERR_LINE_MAX_CHARS,
  STDERR_TAIL_LINES,
  type ChildEraLabel,
  type UpstreamLogContext,
  type UpstreamLogLevel,
  type UpstreamSnapshot,
  type UpstreamType,
} from "../protocol.js";

/** Hands a message to every bridge using the connection; `stderr` is a stopped STDIO server's last lines. */
export type UpstreamReport = (level: UpstreamLogLevel, message: string, context: UpstreamLogContext, stderr?: string[]) => void;

export type ConnectionCloseReason = "idle" | "shutdown";

interface ConnectionBase {
  readonly client: UpstreamClient;
  /** Resolves once the connection no longer needs anything the pool holds. */
  close(reason: ConnectionCloseReason): Promise<void>;
  /** What failing its health checks does, in place of connecting again. */
  onUnhealthy?(): Promise<void>;
}

/** An HTTP or SSE connection, whose OAuth provider shares the credential store with everything else. */
export interface HttpPoolConnection extends ConnectionBase {
  readonly type: Exclude<UpstreamType, "stdio">;
  /** Connects again with the stored credentials, and stops its OAuth provider changing them. */
  credentialsChanged(): Promise<void>;
  /** Keeps its OAuth provider from changing stored credentials any more. */
  retireAuth(): void;
  /** Stops waiting for refreshes to save after `ms`, if still closing. */
  limitSaveWait(ms: number): void;
}

/** A STDIO server the daemon runs. */
export interface StdioPoolConnection extends ConnectionBase {
  readonly type: "stdio";
  /** Starts the server again, saying why. */
  restart(reason: ChildRestartReason): Promise<void>;
  /** The server process running now. */
  child(): RunningChild | undefined;
}

export type PoolConnection = HttpPoolConnection | StdioPoolConnection;

export interface RunningChild {
  pid: number;
  era: ChildEraLabel;
  startedAt: number;
}

export interface ConnectionDeps {
  key: string;
  /** The name the first owner gives the upstream; it names the connection's client and its lines in the daemon log. */
  name: string;
  /** Logs to the daemon log and reports warnings and errors to the connection's bridges. */
  logger: Logger;
  report: UpstreamReport;
}

export interface PooledUpstreamSpec {
  key: string;
  name: string;
  healthCheckIntervalSec: number;
  connect(deps: ConnectionDeps): PoolConnection;
}

export interface PooledUpstreamListener {
  onSnapshot(snapshot: UpstreamSnapshot): void;
  onLog(level: UpstreamLogLevel, message: string, context: UpstreamLogContext, stderr?: string[]): void;
}

interface Owner {
  owner: object;
  /** The instance the owner belongs to; one instance may hold several leases under different names. */
  instance: object;
  /** The name the owner gives the upstream. */
  name: string;
  healthCheckIntervalSec: number;
}

/** A shared connection, its health checks and the bridges' view of it. */
export class PooledUpstream {
  readonly key: string;
  readonly connection: PoolConnection;
  private readonly _firstName: string;
  private readonly _client: UpstreamClient;
  private readonly _log: Logger;
  private readonly _health: HealthChecks;
  private readonly _owners: Owner[] = [];
  private readonly _listeners = new Set<PooledUpstreamListener>();
  private readonly _unsubscribers: Array<() => void>;
  private _lastError: string | undefined;
  private _published: { snapshot: UpstreamSnapshot; toolsRef: unknown; toolsText: string } | undefined;
  private _pauseLogged = false;

  constructor(spec: PooledUpstreamSpec, daemonLogger: Logger) {
    this.key = spec.key;
    this._firstName = spec.name;
    this._log = daemonLogger.child({ component: "upstream", server: spec.name });
    const report: UpstreamReport = (level, message, context, stderr) => this._report(level, message, context, stderr);
    const reporting = new ReportingLogger(this._log, report);
    this.connection = spec.connect({ key: spec.key, name: spec.name, logger: reporting, report });
    this._client = this.connection.client;
    const { connection } = this;
    this._health = new HealthChecks({
      intervalSec: spec.healthCheckIntervalSec,
      logger: reporting,
      ...(connection.onUnhealthy !== undefined && { onUnhealthy: () => connection.onUnhealthy!() }),
    });
    this._health.add(this._client, spec.name);
    this._unsubscribers = [
      this._client.onStatusChange((event) => this._onStatusChange(event)),
      this._client.onToolsChanged(() => this._publish()),
    ];
    this._log.info(`connecting (${this.connection.type})`);
    this._client.connect().catch((err: unknown) => this._logConnectFailure(err));
    this._health.start();
  }

  get type(): UpstreamType {
    return this.connection.type;
  }

  /** The name the longest-standing owner gives the upstream. */
  get name(): string {
    return this._owners[0]?.name ?? this._firstName;
  }

  get status(): ConnectionStatus {
    return this._client.status;
  }

  /** How many owners hold this connection. */
  get ownerCount(): number {
    return this._owners.length;
  }

  /** How many instances use this connection. */
  get instanceCount(): number {
    return new Set(this._owners.map((entry) => entry.instance)).size;
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

  /** Starts its STDIO server again; false when it has none. */
  restart(): boolean {
    if (this.connection.type !== "stdio") return false;
    this.connection.restart("restart").catch((err: unknown) => this._logConnectFailure(err));
    return true;
  }

  subscribe(listener: PooledUpstreamListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  addOwner(owner: object, instance: object, name: string, healthCheckIntervalSec: number): void {
    this._owners.push({ owner, instance, name, healthCheckIntervalSec });
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

  async close(reason: ConnectionCloseReason): Promise<void> {
    this._health.stop();
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._listeners.clear();
    await this.connection.close(reason);
  }

  private _logConnectFailure(err: unknown): void {
    if (!(err instanceof ConnectionSupersededError)) this._log.warn(`failed to connect: ${err instanceof Error ? err.message : String(err)}`);
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

  private _report(level: UpstreamLogLevel, message: string, context: UpstreamLogContext, stderr?: string[]): void {
    const lines = stderr?.slice(-STDERR_TAIL_LINES).map((line) => capStderrLine(line, STDERR_LINE_MAX_CHARS));
    for (const listener of [...this._listeners]) listener.onLog(level, capStderrLine(message, STDERR_LINE_MAX_CHARS), context, lines);
  }
}

/** Logs to `inner` and also hands warnings and errors to `report`, with the context that is safe to send. */
class ReportingLogger implements Logger {
  constructor(
    private readonly _inner: Logger,
    private readonly _report: UpstreamReport,
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
    this._report(level, message, reportable({ ...this._defaults, ...context }));
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
