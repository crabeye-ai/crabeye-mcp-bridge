import { parseJSONRPCMessage, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/client";
import { DEFAULT_KILL_GRACE_MS } from "../../constants.js";
import { ChildHandle, type ChildHandleOptions, type ProcessExit } from "../child-handle.js";

/** Why the daemon stopped a child itself. */
export type ChildStopReason = "failed to connect" | "idle" | "not answering pings" | "restart" | "shutdown";

/** Why the daemon starts a running child again. */
export type ChildRestartReason = Extract<ChildStopReason, "restart" | "not answering pings">;

const ENDED_BY: Record<ChildStopReason, string> = {
  "failed to connect": "child stopped",
  idle: "child stopped",
  "not answering pings": "child not answering pings",
  restart: "upstream restarted",
  shutdown: "child stopped",
};

const EXITED = "child process exited";

const PROBE_METHOD = "server/discover";

/** The part of `ChildHandle` a transport uses; tests substitute their own. */
export type RunningProcess = Pick<ChildHandle, "pid" | "startedAt" | "exitStatus" | "lastSignalSent" | "stderrTail" | "send" | "kill">;

export type SpawnChild = (options: ChildHandleOptions) => RunningProcess;

/** What happens to the children a transport starts. */
export interface ChildEvents {
  started(child: RunningProcess): void;
  /** The child exited, failed to start, closed its output or flooded it without being asked to stop; it has been killed if it hadn't exited. */
  exited(child: RunningProcess, exit: ProcessExit): Promise<void>;
  /** The daemon stopped the child itself, for `reason`. */
  stopped(child: RunningProcess, reason: ChildStopReason): Promise<void>;
  /** Output the child sent that can't be read, or a failure starting or writing to it. */
  error(error: Error): void;
}

export interface ChildTransportOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  killGraceMs?: number;
  stderrDrainMs?: number;
  events: ChildEvents;
  onStderr(line: string): void;
  spawnChild?: SpawnChild;
}

const spawnChildHandle: SpawnChild = (options) => new ChildHandle(options);

/**
 * An MCP transport over one STDIO server process: starting it spawns the
 * process, closing it stops the process, and the process ending closes it at
 * once, reporting how it ended once its stderr has been read.
 */
export class ChildTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly _opts: ChildTransportOptions;
  private _child: RunningProcess | undefined;
  private _stopReason: ChildStopReason = "failed to connect";
  private _stopping = false;
  private _probing = true;
  private _askedFirst: boolean | undefined;
  private readonly _probeIds = new Set<string | number>();
  private _answeredOther = false;
  private _quitOnProbe = false;
  private _endedBecause: string | undefined;
  private _closing: Promise<void> | undefined;
  private _exitReported: Promise<void> | undefined;
  private _reportExit: () => void = () => {};

  constructor(options: ChildTransportOptions) {
    this._opts = options;
  }

  get child(): RunningProcess | undefined {
    return this._child;
  }

  /** Nothing but the protocol version question has been sent to the server. */
  get probing(): boolean {
    return this._probing;
  }

  /**
   * The server, asked the protocol version question first, quit on its own
   * after starting and before answering anything else. Settled once `close()`
   * has resolved.
   */
  get quitOnProbe(): boolean {
    return this._quitOnProbe;
  }

  /** Why the server went away, for the requests it left unanswered. */
  get endedBecause(): string | undefined {
    return this._endedBecause;
  }

  /** From now on, closing stops a running child as a restart unless told otherwise. */
  markConnected(): void {
    this._stopReason = "restart";
  }

  /** Why the next `close()` stops the child. */
  stopFor(reason: ChildStopReason): void {
    this._stopReason = reason;
  }

  async start(): Promise<void> {
    if (this._child !== undefined) throw new Error("child transport already started");
    const spawnChild = this._opts.spawnChild ?? spawnChildHandle;
    this._child = spawnChild({
      command: this._opts.command,
      args: this._opts.args,
      env: this._opts.env,
      cwd: this._opts.cwd,
      stderrDrainMs: this._opts.stderrDrainMs,
      onMessage: (payload) => this._receive(payload),
      onExit: () => this._end(),
      onClose: (exit) => this._closed(exit),
      onError: (err) => this._error(err),
      onStderr: (line) => this._opts.onStderr(line),
    });
    this._opts.events.started(this._child);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this._child === undefined || this._endedBecause !== undefined) throw new Error("STDIO server is not running");
    const probe = "method" in message && message.method === PROBE_METHOD;
    this._askedFirst ??= probe;
    if (!probe) this._probing = false;
    else if ("id" in message) this._probeIds.add(message.id);
    this._child.send(message);
  }

  /** Stops the child unless it already ended; resolves once it is gone and recorded as such, however often it is called. */
  close(): Promise<void> {
    this._closing ??= this._stop();
    return this._closing;
  }

  private async _stop(): Promise<void> {
    if (this._endedBecause !== undefined) {
      await this._exitReported;
      return;
    }
    const reason = this._stopReason;
    this._stopping = true;
    this._endedBecause = ENDED_BY[reason];
    const child = this._child;
    if (child !== undefined) {
      await child.kill(this._killGraceMs());
      await this._opts.events.stopped(child, reason);
    }
    this.onclose?.();
  }

  private _receive(payload: unknown): void {
    let message: JSONRPCMessage;
    try {
      message = parseJSONRPCMessage(payload);
    } catch {
      this._error(new Error("STDIO server sent a message that isn't JSON-RPC"));
      return;
    }
    if (!("method" in message) && "id" in message && message.id !== undefined && !this._probeIds.has(message.id)) this._answeredOther = true;
    this.onmessage?.(message);
  }

  private _error(error: Error): void {
    this._opts.events.error(error);
    this.onerror?.(error);
  }

  private _end(): void {
    if (this._endedBecause !== undefined) return;
    this._endedBecause = EXITED;
    this._exitReported = new Promise((resolve) => (this._reportExit = resolve));
    this.onclose?.();
  }

  /**
   * Reports how a child that ended on its own ended, once it is gone. One that
   * quit while it had only been asked which protocol versions it speaks counts
   * as failing to connect, not as a crash.
   */
  private _closed(exit: ProcessExit): void {
    if (this._stopping) return;
    this._end();
    this._quitOnProbe = this._askedFirst === true && !this._answeredOther && exit.cause === "exited";
    const child = this._child!;
    const report = this._reportExit;
    const { events } = this._opts;
    void child
      .kill(this._killGraceMs())
      .then(() => (this._quitOnProbe ? events.stopped(child, "failed to connect") : events.exited(child, exit)))
      .catch((err: unknown) => events.error(err instanceof Error ? err : new Error(String(err))))
      .finally(report);
  }

  private _killGraceMs(): number {
    return this._opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }
}

/** How a child the daemon stopped ended: its exit, or the last signal sent when it hadn't exited yet. */
export function stopOutcome(child: RunningProcess): Pick<ProcessExit, "code" | "signal"> | { lastSignalSent: NodeJS.Signals | null } {
  return child.exitStatus ?? { lastSignalSent: child.lastSignalSent };
}
