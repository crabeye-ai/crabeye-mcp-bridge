import type { RateLimitConfig } from "../config/schema.js";

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
   * (i.e. the window was full). Reset by `setOnFirstBlock()`. Used by the
   * wiring layer to log a one-time hint when a *default* limit first blocks
   * a call on an upstream. The callback should be lightweight — it runs
   * synchronously before the waiter is enqueued.
   */
  onFirstBlock?: () => void;
}

const DEFAULT_QUEUE_MULTIPLIER = 10;

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
  }

  async acquire(): Promise<void> {
    this.prune();

    if (this.timestamps.length < this.maxCalls) {
      this.timestamps.push(Date.now());
      return;
    }

    // Backpressure: refuse to grow the queue past the configured cap. Bounds
    // memory + timer count when an upstream stalls under sustained burst.
    if (this.queue.length >= this.maxQueued) {
      throw new Error("Rate limit queue full");
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
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(new Error("Rate limit timeout: too many calls queued"));
      }, this.timeoutMs);

      this.queue.push({ resolve, reject, timer });
      this.scheduleDrain();
    });
  }

  reconfigure(config: RateLimitConfig): void {
    this.maxCalls = config.maxCalls;
    this.windowMs = config.windowSeconds * 1000;
    this.maxQueued = config.maxCalls * DEFAULT_QUEUE_MULTIPLIER;
    this.tryDrain();
  }

  /**
   * Swap the first-block callback. Resets the "already fired" flag so the new
   * callback gets one shot. Pass `undefined` to clear (e.g. when an upstream
   * transitions from default-sourced to an explicit per-server limit).
   */
  setOnFirstBlock(cb: (() => void) | undefined): void {
    this.onFirstBlock = cb;
    this.firstBlockFired = false;
  }

  dispose(): void {
    this.teardown(false);
  }

  /**
   * Tear down while *resolving* (not rejecting) queued waiters in FIFO order.
   * Used when a hot-reload removes the limit for this upstream — the user's
   * intent is to lift the limit, so queued calls should fire, not error.
   * Process shutdown still uses `dispose()`.
   */
  drainAndDispose(): void {
    this.teardown(true);
  }

  private teardown(resolveQueued: boolean): void {
    if (this.drainTimer !== undefined) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    for (const waiter of this.queue) {
      clearTimeout(waiter.timer);
      if (resolveQueued) waiter.resolve();
      else waiter.reject(new Error("Rate limiter disposed"));
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
