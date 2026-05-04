import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ERROR_CODE_BACKPRESSURE } from "./protocol.js";

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

export class BackpressureError extends Error {
  readonly code = ERROR_CODE_BACKPRESSURE;
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
  /** Called once when the child exits or stdout ends. */
  onClose: () => void;
  /** Called for unrecoverable errors (spawn failure, parse failure). */
  onError: (err: Error) => void;
  /** Optional per-line stderr forwarder. */
  onStderr?: (line: string) => void;
  /** Override stdin queue cap. Defaults to 1 MiB. */
  queueMaxBytes?: number;
  /** Override stdout buffer cap. Defaults to 8 MiB. */
  stdoutMaxBytes?: number;
}

/**
 * Wraps a spawned child process whose stdio speaks newline-delimited
 * JSON-RPC (the MCP stdio framing). Owns the single-writer stdin queue
 * and the stdout line parser; the daemon reads parsed payloads via the
 * `onMessage` callback.
 *
 * Phase B: at most one session writes through a `ChildHandle`. Phase C
 * fan-in from N sessions reuses this exact queue — `send()` is the only
 * write surface.
 */
export class ChildHandle {
  readonly startedAt: number;
  private child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = "";
  private closed = false;
  private readonly queueMaxBytes: number;
  private readonly stdoutMaxBytes: number;
  private readonly opts: ChildHandleOptions;

  constructor(opts: ChildHandleOptions) {
    this.opts = opts;
    this.queueMaxBytes = opts.queueMaxBytes ?? DEFAULT_QUEUE_MAX_BYTES;
    this.stdoutMaxBytes = opts.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES;
    this.startedAt = Date.now();

    try {
      this.child = spawn(opts.command, opts.args, {
        env: opts.env,
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      throw new Error(
        `spawn failed for ${opts.command}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.child.on("error", (err) => {
      if (this.closed) return;
      opts.onError(err);
    });

    this.child.on("exit", () => {
      if (this.closed) return;
      this.closed = true;
      opts.onClose();
    });

    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => this._onStdout(chunk));
    this.child.stdout.on("end", () => {
      if (this.closed) return;
      this.closed = true;
      opts.onClose();
    });

    if (opts.onStderr) {
      this.child.stderr.setEncoding("utf-8");
      this.child.stderr.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          const t = line.trimEnd();
          if (t.length > 0) opts.onStderr!(t);
        }
      });
    }
  }

  /** PID of the spawned child, or null if the spawn never produced one. */
  get pid(): number | null {
    return this.child.pid ?? null;
  }

  /** True until the child exits or `kill()` runs to completion. */
  get alive(): boolean {
    return !this.closed && this.child.exitCode === null;
  }

  /**
   * Append one MCP JSON-RPC message to the child's stdin. Throws
   * `BackpressureError` (code: backpressure) when the cumulative outstanding
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
   * Kill the child with SIGTERM, then SIGKILL after `graceMs`. Resolves once
   * the child has exited or the kill window has elapsed.
   */
  async kill(graceMs = 2000): Promise<void> {
    if (this.closed || this.child.exitCode !== null) {
      this.closed = true;
      return;
    }
    this.closed = true;

    try {
      this.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }

    const exited = await waitForExit(this.child, graceMs);
    if (exited) return;

    try {
      this.child.kill("SIGKILL");
    } catch {
      /* gone between checks */
    }
    await waitForExit(this.child, graceMs);
  }

  private _onStdout(chunk: string): void {
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
        } catch (err) {
          this.opts.onError(
            new Error(
              `child stdout produced invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
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
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(child.exitCode !== null);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}
