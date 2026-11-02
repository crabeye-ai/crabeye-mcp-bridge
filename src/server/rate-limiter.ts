import type { RateLimitConfig } from "../config/schema.js";
import { CallRefusedError } from "../upstream/call-errors.js";

export type { RateLimitConfig };

const DEFAULT_TIMEOUT_MS = 60_000;

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RateLimiterOptions {
  timeoutMs?: number;
  /**
   * Hard cap on queued waiters. Past this, `acquire()` rejects immediately
   * with a "Rate limit queue full" error instead of enqueueing — backpressure
   * to the caller (and bound on Waiter/timer memory) when an upstream stalls
   * under sustained burst. Defaults to `maxCalls * 10`.
   */
  maxQueued?: number;
  /**
   * Fires exactly once, the first time `acquire()` has to enqueue a waiter
   * (i.e. the window was full). Re-armed by `setOnFirstBlock()`. The callback
   * should be lightweight — it runs synchronously before the waiter is enqueued.
   */
  onFirstBlock?: () => void;
  /** When calls were made within the window before this limiter, which count against it until they leave the window. */
  recentCalls?: readonly number[];
}

const DEFAULT_QUEUE_MULTIPLIER = 10;

function waitCancelledError(): Error {
  return new Error("Rate limit wait cancelled");
}

class RateLimiterDisposedError extends Error {
  constructor() {
    super("Rate limiter disposed");
    this.name = "RateLimiterDisposedError";
  }
}

export class RateLimiter {
  private maxCalls: number;
  private windowMs: number;
  private timeoutMs: number;
  private maxQueued: number;
  private timestamps: number[] = [];
  private queue: Waiter[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private onFirstBlock: (() => void) | undefined;
  private firstBlockFired = false;

  constructor(config: RateLimitConfig, opts: RateLimiterOptions = {}) {
    this.maxCalls = config.maxCalls;
    this.windowMs = config.windowSeconds * 1000;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxQueued = opts.maxQueued ?? config.maxCalls * DEFAULT_QUEUE_MULTIPLIER;
    this.onFirstBlock = opts.onFirstBlock;
    this.timestamps = [...(opts.recentCalls ?? [])];
  }

  /** When the calls still within the window were made, oldest first. */
  recentCalls(): number[] {
    this.prune();
    return [...this.timestamps];
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw waitCancelledError();
    this.prune();

    if (this.timestamps.length < this.maxCalls) {
      this.timestamps.push(Date.now());
      return;
    }

    // Backpressure: refuse to grow the queue past the configured cap. Bounds
    // memory + timer count when an upstream stalls under sustained burst.
    if (this.queue.length >= this.maxQueued) {
      throw new CallRefusedError("Rate limit queue full");
    }

    if (!this.firstBlockFired) {
      this.firstBlockFired = true;
      // Defensive: don't let a logger throw break acquire().
      try {
        this.onFirstBlock?.();
      } catch {
        // swallow
      }
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.dequeue(waiter);
        waiter.reject(waitCancelledError());
      };
      const waiter: Waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (err) => {
          signal?.removeEventListener("abort", onAbort);
          reject(err);
        },
        timer: setTimeout(() => {
          this.dequeue(waiter);
          waiter.reject(new CallRefusedError("Rate limit timeout: too many calls queued"));
        }, this.timeoutMs),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
      this.scheduleDrain();
    });
  }

  private dequeue(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    const idx = this.queue.indexOf(waiter);
    if (idx !== -1) this.queue.splice(idx, 1);
    this.scheduleDrain();
  }

  reconfigure(config: RateLimitConfig): void {
    this.maxCalls = config.maxCalls;
    this.windowMs = config.windowSeconds * 1000;
    this.maxQueued = config.maxCalls * DEFAULT_QUEUE_MULTIPLIER;
    this.tryDrain();
  }

  /** Swaps the first-block callback and re-arms it, so it fires again the next time a call has to wait; `undefined` clears it. */
  setOnFirstBlock(cb: (() => void) | undefined): void {
    this.onFirstBlock = cb;
    this.firstBlockFired = false;
  }

  /** Stops the limiter, rejecting the calls still waiting with `RateLimiterDisposedError`. */
  dispose(): void {
    if (this.drainTimer !== undefined) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    for (const waiter of this.queue) {
      clearTimeout(waiter.timer);
      waiter.reject(new RateLimiterDisposedError());
    }
    this.queue = [];
    this.timestamps = [];
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] <= cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
  }

  private tryDrain(): void {
    this.prune();
    while (this.queue.length > 0 && this.timestamps.length < this.maxCalls) {
      const waiter = this.queue.shift()!;
      clearTimeout(waiter.timer);
      this.timestamps.push(Date.now());
      waiter.resolve();
    }
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== undefined) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    if (this.queue.length === 0 || this.timestamps.length === 0) return;

    const oldestExpiry = this.timestamps[0] + this.windowMs - Date.now();
    const delay = Math.max(1, oldestExpiry);
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      this.tryDrain();
    }, delay);
  }
}
