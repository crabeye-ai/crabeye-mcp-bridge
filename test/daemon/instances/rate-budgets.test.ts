import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitConfig } from "../../../src/config/schema.js";
import { RateBudgets, type SlotOutcome } from "../../../src/daemon/instances/rate-budgets.js";
import { CallRefusedError } from "../../../src/upstream/call-errors.js";
import type { ResolvedRateLimit } from "../../../src/server/rate-limit-resolution.js";

const WINDOW_MS = 30_000;
const explicit = (maxCalls: number, windowSeconds = WINDOW_MS / 1000): ResolvedRateLimit => ({ kind: "config", config: { maxCalls, windowSeconds }, source: "explicit" });
const byDefault = (maxCalls: number, windowSeconds = WINDOW_MS / 1000): ResolvedRateLimit => ({ kind: "config", config: { maxCalls, windowSeconds }, source: "default" });
const DISABLED: ResolvedRateLimit = { kind: "disabled" };

describe("RateBudgets", () => {
  let budgets: RateBudgets;
  let hints: Array<{ owner: string; config: RateLimitConfig }>;
  const [a, b] = [{}, {}];
  const hintTo = (owner: string) => (config: RateLimitConfig) => hints.push({ owner, config });

  beforeEach(() => {
    vi.useFakeTimers();
    hints = [];
    budgets = new RateBudgets();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function slot(owner: object, signal = new AbortController().signal) {
    let settled: SlotOutcome | Error | undefined;
    void budgets.takeSlot(owner, signal).then(
      (outcome) => (settled = outcome),
      (err: Error) => (settled = err),
    );
    return { state: () => settled };
  }

  const take = (owner: object) => budgets.takeSlot(owner, new AbortController().signal);
  const flush = () => vi.advanceTimersByTimeAsync(0);

  it("shares one budget between owners of a connection under the same limit", async () => {
    budgets.add(a, "k", explicit(1));
    budgets.add(b, "k", explicit(1));
    await take(a);

    const waiting = slot(b);
    await flush();

    expect(waiting.state()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(waiting.state()).toBe("granted");
  });

  it.each([
    ["a different limit on the same connection", "k", explicit(2)],
    ["the same limit on another connection", "other", explicit(1)],
  ])("gives %s its own budget", async (_case, key, limit) => {
    budgets.add(a, "k", explicit(1));
    budgets.add(b, key, limit);
    await take(a);

    const free = slot(b);
    await flush();

    expect(free.state()).toBe("granted");
  });

  it("grants a slot at once to an owner with no limit, and answers released for one it doesn't know", async () => {
    budgets.add(a, "k", DISABLED);

    for (let i = 0; i < 5; i++) expect(await take(a)).toBe("granted");
    expect(await take({})).toBe("released");
  });

  it("changes the limit of a budget its owner used alone in place, keeping its window and waiting calls", async () => {
    budgets.add(a, "k", explicit(1));
    await take(a);
    const waiting = slot(a);
    await flush();

    budgets.setLimit(a, explicit(3));
    await flush();

    expect(waiting.state()).toBe("granted");
    await take(a);
    const fourth = slot(a);
    await flush();
    expect(fourth.state()).toBeUndefined();
  });

  it("keeps the window and waiting calls of an owner whose limit is set again unchanged", async () => {
    budgets.add(a, "k", explicit(1));
    await take(a);
    const waiting = slot(a);
    await flush();

    budgets.setLimit(a, explicit(1));
    await flush();

    expect(waiting.state()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(waiting.state()).toBe("granted");
  });

  it("moves an owner whose limit changes off a shared budget, its waiting calls with it, still counting the calls made in the window", async () => {
    budgets.add(a, "k", explicit(1));
    budgets.add(b, "k", explicit(1));
    await take(a);
    const [first, second] = [slot(a), slot(a)];
    const shared = slot(b);
    await flush();

    budgets.setLimit(a, explicit(1, 45));
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect([first.state(), second.state(), shared.state()]).toEqual([undefined, undefined, "granted"]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect([first.state(), second.state()]).toEqual(["granted", undefined]);
  });

  it("moves the waiting calls of an owner joining a budget others already have, still holding them to its limit", async () => {
    budgets.add(a, "k", explicit(1));
    budgets.add(b, "k", explicit(2));
    await take(a);
    const waiting = slot(a);
    await take(b);
    await take(b);

    budgets.setLimit(a, explicit(2));
    await flush();

    expect(waiting.state()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(waiting.state()).toBe("granted");
  });

  it.each([
    ["it used alone", false],
    ["it shares with another owner", true],
  ])("lets an owner's waiting calls run when its limit is lifted, from a budget %s", async (_case, shared) => {
    budgets.add(a, "k", explicit(1));
    if (shared) budgets.add(b, "k", explicit(1));
    await take(a);
    const waiting = slot(a);
    await flush();

    budgets.setLimit(a, DISABLED);
    await flush();

    expect(waiting.state()).toBe("granted");
    expect(await take(a)).toBe("granted");
  });

  it.each([
    ["it used alone", false],
    ["it shares with another owner", true],
  ])("tells an owner's waiting calls at once that it was released, from a budget %s", async (_case, shared) => {
    budgets.add(a, "k", explicit(1));
    if (shared) budgets.add(b, "k", explicit(1));
    await take(a);
    const waiting = slot(a);
    await flush();

    budgets.release(a);
    await flush();

    expect(waiting.state()).toBe("released");
  });

  it("tells a waiting call its owner was released when it moves and is then released at once", async () => {
    budgets.add(a, "k", explicit(1));
    budgets.add(b, "k", explicit(1));
    await take(a);
    const waiting = slot(a);
    await flush();

    budgets.setLimit(a, explicit(1, 60));
    budgets.release(a);
    await flush();

    expect(waiting.state()).toBe("released");
  });

  it("keeps a released owner's calls in the window of the owners still using its budget", async () => {
    budgets.add(a, "k", explicit(1));
    budgets.add(b, "k", explicit(1));
    await take(a);
    const waiting = slot(a);
    await flush();

    budgets.release(a);
    await flush();

    expect(waiting.state()).toBe("released");
    const shared = slot(b);
    await flush();
    expect(shared.state()).toBeUndefined();
  });

  it("keeps the window of a budget whose owners all move to a new limit, one after the other", async () => {
    budgets.add(a, "k", explicit(2));
    budgets.add(b, "k", explicit(2));
    await take(a);
    await take(b);

    budgets.setLimit(a, explicit(3));
    budgets.setLimit(b, explicit(3));
    await take(a);
    const fourth = slot(b);
    await flush();

    expect(fourth.state()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);
    expect(fourth.state()).toBe("granted");
  });

  it("gives up a waiting call's place when it is cancelled, so the next one gets the slot", async () => {
    budgets.add(a, "k", explicit(1));
    await take(a);
    const cancel = new AbortController();
    const cancelled = slot(a, cancel.signal);
    const next = slot(a);
    await flush();

    cancel.abort();
    await vi.advanceTimersByTimeAsync(WINDOW_MS);

    expect(cancelled.state()).toEqual(new Error("Rate limit wait cancelled"));
    expect(next.state()).toBe("granted");
  });

  it("refuses a call once the queue is full, and times out a waiting one, with the usual messages", async () => {
    budgets.add(a, "k", explicit(1, 600));
    await take(a);
    const queued = Array.from({ length: 10 }, () => slot(a));

    await expect(take(a)).rejects.toEqual(new CallRefusedError("Rate limit queue full"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queued.map((call) => call.state())).toEqual(Array.from({ length: 10 }, () => new CallRefusedError("Rate limit timeout: too many calls queued")));
  });

  it("hints once per budget, to the owners following a default limit, the first time it makes a call wait", async () => {
    budgets.add(a, "k", byDefault(1), hintTo("a"));
    budgets.add(b, "k", explicit(1), hintTo("b"));
    for (let i = 0; i < 4; i++) slot(a);
    await flush();

    expect(hints).toEqual([{ owner: "a", config: { maxCalls: 1, windowSeconds: 30 } }]);
  });

  it("hints again after a budget moves to a new default limit", async () => {
    budgets.add(a, "k", byDefault(1), hintTo("a"));
    slot(a);
    slot(a);
    await flush();

    budgets.setLimit(a, byDefault(2, 600));
    for (let i = 0; i < 3; i++) slot(a);
    await flush();

    expect(hints.map(({ config }) => config.maxCalls)).toEqual([1, 2]);
  });
});
