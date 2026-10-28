import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitedReport } from "../../src/daemon/rate-limited-report.js";

describe("RateLimitedReport", () => {
  let reports: [number, string][];
  let report: RateLimitedReport<string>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    reports = [];
    report = new RateLimitedReport<string>(1_000, (count, latest) => reports.push([count, latest]));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports the first offer at once", () => {
    report.offer("a");
    expect(reports).toEqual([[1, "a"]]);
  });

  it("holds back an offer that comes right after a timed report", () => {
    report.offer("a");
    report.offer("b");
    vi.advanceTimersByTime(1_000);
    report.offer("c");

    expect(reports).toEqual([[1, "a"], [1, "b"]]);
  });

  it("reports what it held back once the interval has passed, without another offer", () => {
    report.offer("a");
    report.offer("b");
    report.offer("c");

    vi.advanceTimersByTime(999);
    expect(reports).toEqual([[1, "a"]]);
    vi.advanceTimersByTime(1);

    expect(reports).toEqual([[1, "a"], [2, "c"]]);
  });

  it("doesn't report again on the timer after a flush", () => {
    report.offer("a");
    report.offer("b");
    report.flush();

    vi.advanceTimersByTime(5_000);

    expect(reports).toEqual([[1, "a"], [1, "b"]]);
  });

  it("reports what it held back when flushed, and nothing when there is nothing held", () => {
    report.offer("a");
    report.offer("b");
    report.flush();
    report.flush();
    expect(reports).toEqual([[1, "a"], [1, "b"]]);
  });

  it("starts a new interval after a flush", () => {
    report.offer("a");
    report.offer("b");
    report.flush();
    report.offer("c");
    expect(reports).toEqual([[1, "a"], [1, "b"]]);
  });
});
