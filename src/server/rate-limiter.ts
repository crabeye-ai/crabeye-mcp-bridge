import type { RateLimitConfig } from "../config/schema.js";

export type { RateLimitConfig };

const DEFAULT_TIMEOUT_MS = 30_000;

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RateLimiter {
  private maxCalls: number;
  private windowMs: number;
  private timeoutMs: number;
  private timestamps: number[] = [];
  private queue: Waiter[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(config: RateLimitConfig, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.maxCalls = config.maxCalls;
    this.windowMs = config.windowSeconds * 1000;
    this.timeoutMs = timeoutMs;
  }

  async acquire(): Promise<void> {
    this.prune();

    if (this.timestamps.length < this.maxCalls) {
      this.timestamps.push(Date.now());
      return;
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
    this.tryDrain();
  }

  dispose(): void {
    if (this.drainTimer !== undefined) {
      clearTimeout(this.drainTimer);
      this.drainTimer = undefined;
    }
    for (const waiter of this.queue) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Rate limiter disposed"));
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
