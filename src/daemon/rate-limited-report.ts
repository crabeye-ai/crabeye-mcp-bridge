export class RateLimitedReport<T> {
  private held = 0;
  private latest: T | undefined;
  private reportedAt = Number.NEGATIVE_INFINITY;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly intervalMs: number,
    private readonly report: (count: number, latest: T) => void,
  ) {}

  offer(details: T): void {
    this.held++;
    this.latest = details;
    const wait = this.reportedAt + this.intervalMs - performance.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => this.flush(), wait).unref();
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.held === 0) return;
    const count = this.held;
    const latest = this.latest as T;
    this.reportedAt = performance.now();
    this.held = 0;
    this.latest = undefined;
    this.report(count, latest);
  }
}
