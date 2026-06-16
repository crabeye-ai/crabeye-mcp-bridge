import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter } from "../../src/server/rate-limiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses a 60s default queue timeout", async () => {
    const rl = new RateLimiter({ maxCalls: 1, windowSeconds: 60 });
    await rl.acquire(); // fills the window
    const queued = rl.acquire();

    const onReject = vi.fn();
    queued.catch(onReject);

    // Just before 60s — still pending.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(onReject).not.toHaveBeenCalled();

    // Cross the 60s boundary — the queued call times out.
    await vi.advanceTimersByTimeAsync(2);
    expect(onReject).toHaveBeenCalledOnce();
    expect(onReject.mock.calls[0]![0]).toMatchObject({
      message: "Rate limit timeout: too many calls queued",
    });

    rl.dispose();
  });

  it("respects an explicit timeout override", async () => {
    const rl = new RateLimiter(
      { maxCalls: 1, windowSeconds: 60 },
      { timeoutMs: 1_000 },
    );
    await rl.acquire();
    const queued = rl.acquire();
    const onReject = vi.fn();
    queued.catch(onReject);

    await vi.advanceTimersByTimeAsync(1_001);
    expect(onReject).toHaveBeenCalledOnce();

    rl.dispose();
  });

  describe("onFirstBlock", () => {
    it("fires once when the first call has to queue", async () => {
      const onFirstBlock = vi.fn();
      const rl = new RateLimiter(
        { maxCalls: 1, windowSeconds: 60 },
        { onFirstBlock },
      );

      await rl.acquire(); // window not full → no callback
      expect(onFirstBlock).not.toHaveBeenCalled();

      // Now full; this acquire enqueues → first block.
      rl.acquire().catch(() => {});
      expect(onFirstBlock).toHaveBeenCalledOnce();

      // Subsequent blocks do not re-fire.
      rl.acquire().catch(() => {});
      rl.acquire().catch(() => {});
      expect(onFirstBlock).toHaveBeenCalledOnce();

      rl.dispose();
    });

    it("does not fire if no call ever blocks", async () => {
      const onFirstBlock = vi.fn();
      const rl = new RateLimiter(
        { maxCalls: 5, windowSeconds: 60 },
        { onFirstBlock },
      );
      await rl.acquire();
      await rl.acquire();
      await rl.acquire();
      expect(onFirstBlock).not.toHaveBeenCalled();
      rl.dispose();
    });

    it("setOnFirstBlock(cb) re-arms the fired flag", async () => {
      const first = vi.fn();
      const second = vi.fn();
      const rl = new RateLimiter(
        { maxCalls: 1, windowSeconds: 60 },
        { onFirstBlock: first },
      );

      await rl.acquire();
      rl.acquire().catch(() => {});
      expect(first).toHaveBeenCalledOnce();

      rl.setOnFirstBlock(second);
      // First block under the new callback should fire it.
      rl.acquire().catch(() => {});
      expect(second).toHaveBeenCalledOnce();

      rl.dispose();
    });

    it("setOnFirstBlock(undefined) suppresses future logs", async () => {
      const cb = vi.fn();
      const rl = new RateLimiter(
        { maxCalls: 1, windowSeconds: 60 },
        { onFirstBlock: cb },
      );
      await rl.acquire();
      rl.setOnFirstBlock(undefined);
      rl.acquire().catch(() => {});
      expect(cb).not.toHaveBeenCalled();
      rl.dispose();
    });

    it("swallows callback exceptions so acquire() still works", async () => {
      const rl = new RateLimiter(
        { maxCalls: 1, windowSeconds: 60 },
        {
          onFirstBlock: () => {
            throw new Error("boom");
          },
        },
      );
      await rl.acquire();
      // Should not throw; the queued promise just waits normally.
      const queued = rl.acquire();
      const onReject = vi.fn();
      queued.catch(onReject);

      await vi.advanceTimersByTimeAsync(60_001);
      expect(onReject).toHaveBeenCalledOnce(); // normal timeout, not "boom"
      rl.dispose();
    });
  });

  describe("maxQueued", () => {
    it("defaults to maxCalls * 10 and rejects past the cap", async () => {
      const rl = new RateLimiter({ maxCalls: 2, windowSeconds: 60 });
      // Fill the window (2 succeed).
      await rl.acquire();
      await rl.acquire();
      // Queue 20 (the cap). They sit waiting.
      const queued = Array.from({ length: 20 }, () =>
        rl.acquire().catch(() => "rejected"),
      );
      // 21st must reject synchronously with the queue-full error.
      await expect(rl.acquire()).rejects.toThrow("Rate limit queue full");

      rl.dispose();
      // Drain pending so timers don't leak across tests.
      await Promise.all(queued);
    });

    it("honours an explicit maxQueued override", async () => {
      const rl = new RateLimiter(
        { maxCalls: 1, windowSeconds: 60 },
        { maxQueued: 2 },
      );
      await rl.acquire();
      const q1 = rl.acquire().catch(() => "rejected");
      const q2 = rl.acquire().catch(() => "rejected");
      await expect(rl.acquire()).rejects.toThrow("Rate limit queue full");

      rl.dispose();
      await Promise.all([q1, q2]);
    });

    it("reconfigure() updates the cap based on new maxCalls", async () => {
      const rl = new RateLimiter({ maxCalls: 1, windowSeconds: 60 });
      await rl.acquire();
      // Cap was 10. Reconfigure to maxCalls=2 → cap=20.
      rl.reconfigure({ maxCalls: 2, windowSeconds: 60 });
      // Fill the now-wider window first (1 immediate via the freed slot).
      await rl.acquire();
      // Queue 20 to hit the new cap.
      const queued = Array.from({ length: 20 }, () =>
        rl.acquire().catch(() => "rejected"),
      );
      await expect(rl.acquire()).rejects.toThrow("Rate limit queue full");

      rl.dispose();
      await Promise.all(queued);
    });
  });

  describe("drainAndDispose", () => {
    it("resolves queued waiters in FIFO order, never rejects them", async () => {
      const rl = new RateLimiter({ maxCalls: 1, windowSeconds: 60 });
      await rl.acquire(); // fill

      const order: number[] = [];
      const onReject = vi.fn();

      const p1 = rl.acquire().then(() => order.push(1)).catch(onReject);
      const p2 = rl.acquire().then(() => order.push(2)).catch(onReject);
      const p3 = rl.acquire().then(() => order.push(3)).catch(onReject);

      rl.drainAndDispose();
      await Promise.all([p1, p2, p3]);

      expect(order).toEqual([1, 2, 3]);
      expect(onReject).not.toHaveBeenCalled();
    });

    it("dispose() (without drain) still rejects waiters with 'Rate limiter disposed'", async () => {
      const rl = new RateLimiter({ maxCalls: 1, windowSeconds: 60 });
      await rl.acquire();

      const rejected: string[] = [];
      const p1 = rl.acquire().catch((e: Error) => rejected.push(e.message));
      const p2 = rl.acquire().catch((e: Error) => rejected.push(e.message));

      rl.dispose();
      await Promise.all([p1, p2]);

      expect(rejected).toEqual(["Rate limiter disposed", "Rate limiter disposed"]);
    });

    it("is idempotent", () => {
      const rl = new RateLimiter({ maxCalls: 1, windowSeconds: 60 });
      rl.drainAndDispose();
      expect(() => rl.drainAndDispose()).not.toThrow();
      expect(() => rl.dispose()).not.toThrow();
    });
  });
});
