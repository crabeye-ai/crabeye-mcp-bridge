import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { STDERR_DRAIN_MS, StderrCapture } from "./stderr-capture.js";
import { RateLimitedReport } from "./rate-limited-report.js";
import { DEFAULT_KILL_GRACE_MS } from "../constants.js";

/**
 * Per-child stdin queue cap. MCP stdio messages are small (<10 KiB typical);
 * 1 MiB outstanding means hundreds of in-flight messages and indicates the
 * child is wedged. Reject further writes with a typed `backpressure` error
 * rather than letting libuv's queue grow unbounded.
 */
const DEFAULT_QUEUE_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Per-child stdout buffer cap. The newline-delimited JSON parser accumulates
 * until a newline arrives; a misbehaving child that floods stdout without a
 * newline (binary noise, missing `\n` from a logger writing to stdout instead
 * of stderr) would otherwise grow the buffer until the daemon OOMs.
 */
const DEFAULT_STDOUT_MAX_BYTES = 8 * 1024 * 1024;
const NON_JSON_REPORT_INTERVAL_MS = 1_000;

/** How a child process ended without being asked to. */
export interface ProcessExit {
  cause: "exited" | "failed_to_start" | "output_flood";
  code: number | null;
  signal: string | null;
}

export class BackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackpressureError";
  }
}

export interface ChildHandleOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Called once per parsed newline-delimited JSON message from child stdout. */
  onMessage: (payload: unknown) => void;
  /**
   * Called once: when the child exits, closes stdout or fails to start (once it
   * has exited and its stderr has ended, or after `STDERR_DRAIN_MS`), or at once
   * when it floods stdout. Not called after the owner calls `kill()`.
   */
  onClose: (exit: ProcessExit) => void;
  /** Called for unrecoverable errors (spawn failure, parse failure, a failed write to stdin). */
  onError: (err: Error) => void;
  /** Called once, as soon as the child exits or fails to start, before `onClose` waits for the end of its stderr. Not called after the owner calls `kill()`. */
  onExit?: () => void;
  /** Called once per non-blank stderr line, with trailing whitespace removed and cut like `capStderrLine`; a start failure arrives as its error message. */
  onStderr?: (line: string) => void;
  /** Override stdin queue cap. Defaults to 1 MiB. */
  queueMaxBytes?: number;
  /** Override stdout buffer cap. Defaults to 8 MiB. */
  stdoutMaxBytes?: number;
  /** Override how long `onClose` waits for the child's exit and the end of its stderr. Defaults to `STDERR_DRAIN_MS`. */
  stderrDrainMs?: number;
}

/**
 * Wraps a spawned child process whose stdio speaks newline-delimited
 * JSON-RPC (the MCP stdio framing). Owns the single-writer stdin queue
 * and the stdout line parser; its owner reads parsed payloads via the
 * `onMessage` callback.
 */
export class ChildHandle {
  readonly startedAt: number;
  private child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private closed = false;
  private killing: Promise<void> | null = null;
  private readonly queueMaxBytes: number;
  private readonly stdoutMaxBytes: number;
  private readonly stderrDrainMs: number;
  private readonly opts: ChildHandleOptions;
  private readonly stderr: StderrCapture;
  private _exitStatus: Pick<ProcessExit, "code" | "signal"> | null = null;
  private _lastSignalSent: NodeJS.Signals | null = null;
  private readonly nonJsonLines = new RateLimitedReport<number>(NON_JSON_REPORT_INTERVAL_MS, (count, latestBytes) =>
    this.opts.onError(
      new Error(
        count === 1
          ? `child stdout produced a line that isn't JSON (${latestBytes} bytes)`
          : `child stdout produced ${count} lines that aren't JSON since the last report (latest ${latestBytes} bytes)`,
      ),
    ),
  );
  private failedToStart = false;
  private resolveExited!: () => void;
  private readonly exited = new Promise<void>((resolve) => (this.resolveExited = resolve));
  private resolveStderrEnded!: () => void;
  private readonly stderrEnded = new Promise<void>((resolve) => (this.resolveStderrEnded = resolve));

  constructor(opts: ChildHandleOptions) {
    this.opts = opts;
    this.queueMaxBytes = opts.queueMaxBytes ?? DEFAULT_QUEUE_MAX_BYTES;
    this.stdoutMaxBytes = opts.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES;
    this.stderrDrainMs = opts.stderrDrainMs ?? STDERR_DRAIN_MS;
    this.startedAt = Date.now();

    try {
      this.child = spawn(opts.command, opts.args, {
        env: opts.env,
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      throw new Error(`spawn failed for ${opts.command}: ${describeSpawnError(err)}`);
    }

    this.stderr = new StderrCapture((line) => opts.onStderr?.(line));

    this.child.on("error", (err) => {
      if (!this.closed) opts.onError(err);
      if (this.child.pid === undefined) this.reportFailedStart(err);
    });

    this.child.once("exit", (code, signal) => {
      this._exitStatus = { code, signal };
      this.resolveExited();
      this.reportExit();
      this.reportExitWhenDrained();
    });

    this.child.stdin.on("error", (err) => {
      if (!this.closed) opts.onError(err);
    });

    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => this._onStdout(chunk));
    this.child.stdout.on("end", () => this.reportExitWhenDrained());

    this.child.stderr.setEncoding("utf-8");
    this.child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    this.child.stderr.once("close", () => {
      this.stderr.end();
      this.resolveStderrEnded();
    });
  }

  /** The child's last stderr lines, oldest first. */
  stderrTail(): string[] {
    return this.stderr.tail();
  }

  /** PID of the spawned child, or null if the spawn never produced one. */
  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get exitStatus(): Pick<ProcessExit, "code" | "signal"> | null {
    return this._exitStatus;
  }

  get lastSignalSent(): NodeJS.Signals | null {
    return this._lastSignalSent;
  }

  /**
   * Append one MCP JSON-RPC message to the child's stdin. Throws
   * `BackpressureError` when the cumulative outstanding
   * bytes in the kernel + libuv queues would exceed `queueMaxBytes`.
   */
  send(payload: unknown): void {
    if (this.closed) {
      throw new Error("child stdin not writable: child has exited");
    }
    if (!this.child.stdin.writable) {
      throw new Error("child stdin not writable");
    }
    const line = JSON.stringify(payload) + "\n";
    const buf = Buffer.from(line, "utf-8");
    const outstanding = this.child.stdin.writableLength;
    if (outstanding + buf.byteLength > this.queueMaxBytes) {
      throw new BackpressureError(
        `child stdin queue would exceed ${this.queueMaxBytes} bytes (outstanding ${outstanding}, frame ${buf.byteLength})`,
      );
    }
    this.child.stdin.write(buf);
  }

  /**
   * Kill the child with SIGTERM, then SIGKILL after `killGraceMs`. Resolves once
   * the child has exited or the kill window has elapsed. Later calls return the
   * first kill, with its grace. A child that never started gets no signal:
   * until Node reports its failed start, signalling it would signal pid 0, the
   * daemon's whole process group.
   */
  kill(killGraceMs = DEFAULT_KILL_GRACE_MS): Promise<void> {
    this.killing ??= this.terminate(killGraceMs);
    return this.killing;
  }

  private async terminate(killGraceMs: number): Promise<void> {
    this.nonJsonLines.flush();
    this.closed = true;
    if (this.child.pid === undefined || hasExited(this.child)) return;

    try {
      this._lastSignalSent = "SIGTERM";
      this.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }

    const exited = await waitForExit(this.child, killGraceMs);
    if (exited) return;

    try {
      this._lastSignalSent = "SIGKILL";
      this.child.kill("SIGKILL");
    } catch {
      /* gone between checks */
    }
    await waitForExit(this.child, killGraceMs);
  }

  private reportFailedStart(err: Error): void {
    if (this.failedToStart) return;
    this.failedToStart = true;
    this.stderr.push(`${err.message}\n`);
    this.resolveExited();
    this.reportExit();
    this.reportExitWhenDrained();
  }

  private reportExit(): void {
    if (this.killing === null) this.opts.onExit?.();
  }

  private reportExitWhenDrained(): void {
    if (this.closed) return;
    this.closed = true;
    this.nonJsonLines.flush();
    void this.drained().then(() => {
      if (this.killing === null) this.opts.onClose(this.exitReport());
    });
  }

  private exitReport(): ProcessExit {
    return {
      cause: this.failedToStart ? "failed_to_start" : "exited",
      code: this._exitStatus?.code ?? null,
      signal: this._exitStatus?.signal ?? null,
    };
  }

  private drained(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.stderrDrainMs).unref();
      void Promise.all([this.exited, this.stderrEnded]).then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private _onStdout(chunk: string): void {
    if (this.closed) return;
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > this.stdoutMaxBytes) {
      // Misbehaving child: flooding stdout without newlines. Drop the buffer
      // so we don't OOM the daemon, surface the error, and reap the child.
      const overflow = this.stdoutBuffer.length;
      this.stdoutBuffer = "";
      this.opts.onError(
        new Error(
          `child stdout exceeded ${this.stdoutMaxBytes} bytes without a newline (had ${overflow}); killing child`,
        ),
      );
      void this.kill(0);
      this.opts.onClose({ cause: "output_flood", code: null, signal: null });
      return;
    }
    let nl = this.stdoutBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          this.nonJsonLines.offer(Buffer.byteLength(trimmed));
          nl = this.stdoutBuffer.indexOf("\n");
          continue;
        }
        try {
          this.opts.onMessage(parsed);
        } catch (err) {
          this.opts.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      nl = this.stdoutBuffer.indexOf("\n");
    }
  }
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(hasExited(child));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function describeSpawnError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "invalid command, arguments or environment";
}
