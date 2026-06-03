import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ChildPing, type ChildPingDeps } from "../../src/daemon/child-ping.js";

interface Recorder {
  sends: unknown[];
  ids: number[];
  callbacks: Map<number, () => void>;
  wedged: string[];
  nextId: number;
  deps: ChildPingDeps;
  sendShouldThrow: boolean;
}

function makeRecorder(): Recorder {
  const r: Recorder = {
    sends: [],
    ids: [],
    callbacks: new Map(),
    wedged: [],
    nextId: -1,
    deps: {} as ChildPingDeps,
    sendShouldThrow: false,
  };
  r.deps = {
    allocateId: () => {
      const id = r.nextId;
      r.nextId -= 1;
      r.ids.push(id);
      return id;
    },
    registerCallback: (id, cb) => {
      r.callbacks.set(id, cb);
    },
    unregisterCallback: (id) => {
      r.callbacks.delete(id);
    },
    sendPayload: (payload) => {
      if (r.sendShouldThrow) throw new Error("child stdin not writable");
      r.sends.push(payload);
    },
    onWedged: (reason) => {
      r.wedged.push(reason);
    },
  };
  return r;
}

describe("ChildPing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits an MCP ping after one cadence and clears failure count on response", () => {
    const r = makeRecorder();
    const p = new ChildPing({
      pingMs: 1_000,
      timeoutMs: 500,
      maxConsecutiveFailures: 3,
      deps: r.deps,
    });
    p.start();

    // No traffic yet.
    expect(r.sends).toHaveLength(0);

    vi.advanceTimersByTime(1_000);
    expect(r.sends).toHaveLength(1);
    expect(r.sends[0]).toMatchObject({ jsonrpc: "2.0", method: "ping" });
    const id = (r.sends[0] as { id: number }).id;
    expect(id).toBeLessThan(0);
    expect(p._statsForTest().pendingId).toBe(id);

    // Child responds. Stats reset, no failures.
    r.callbacks.get(id)!();
    expect(p._statsForTest()).toMatchObject({
      consecutiveFailures: 0,
      wedged: false,
      pendingId: null,
    });
    p.stop();
  });

  it("counts a missed response as a failure and arms the next ping", () => {
    const r = makeRecorder();
    const p = new ChildPing({
      pingMs: 1_000,
      timeoutMs: 500,
      maxConsecutiveFailures: 3,
      deps: r.deps,
    });
    p.start();

    vi.advanceTimersByTime(1_000); // first ping issued
    expect(r.sends).toHaveLength(1);
    vi.advanceTimersByTime(500); // deadline elapses
    expect(p._statsForTest().consecutiveFailures).toBe(1);
    expect(p._statsForTest().pendingId).toBeNull();

    vi.advanceTimersByTime(500); // next cadence fires
    expect(r.sends).toHaveLength(2);
    p.stop();
  });

  it("calls onWedged after maxConsecutiveFailures and stops issuing further pings", () => {
    const r = makeRecorder();
    const p = new ChildPing({
      pingMs: 1_000,
      timeoutMs: 500,
      maxConsecutiveFailures: 3,
      deps: r.deps,
    });
    p.start();

    // Three consecutive ping windows with no response.
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1_000); // tick → ping sent
      vi.advanceTimersByTime(500); // deadline elapses
    }

    expect(r.wedged).toHaveLength(1);
    expect(r.wedged[0]).toMatch(/3 consecutive ping failures/);
    expect(p.isWedged).toBe(true);

    // After wedge: cadence is stopped, no more sends.
    const sendsBefore = r.sends.length;
    vi.advanceTimersByTime(10_000);
    expect(r.sends).toHaveLength(sendsBefore);
    p.stop();
  });

  it("ignores a late response that arrives after timeout", () => {
    const r = makeRecorder();
    const p = new ChildPing({
      pingMs: 1_000,
      timeoutMs: 500,
      maxConsecutiveFailures: 5,
      deps: r.deps,
    });
    p.start();

    vi.advanceTimersByTime(1_000);
    const firstId = (r.sends[0] as { id: number }).id;
    // Save a reference to the callback BEFORE the timeout drops it.
    const lateCb = r.callbacks.get(firstId)!;

    vi.advanceTimersByTime(500); // first ping times out
    expect(p._statsForTest().consecutiveFailures).toBe(1);
    // The timeout path has unregistered the callback from the deps recorder,
    // but the captured reference is still callable. Invoke it directly to
    // simulate a late response that races into the ChildPing instance after
    // it has already given up on this id.
    lateCb();

    // Failure count must not have been cleared.
    expect(p._statsForTest().consecutiveFailures).toBe(1);
    p.stop();
  });

  it("records a failure when the child stdin write throws", () => {
    const r = makeRecorder();
    r.sendShouldThrow = true;
    const p = new ChildPing({
      pingMs: 1_000,
      timeoutMs: 500,
      maxConsecutiveFailures: 2,
      deps: r.deps,
    });
    p.start();

    vi.advanceTimersByTime(1_000);
    expect(p._statsForTest().consecutiveFailures).toBe(1);
    expect(p._statsForTest().pendingId).toBeNull();

    vi.advanceTimersByTime(1_000);
    expect(r.wedged).toHaveLength(1);
    p.stop();
  });

  it("is disabled when pingMs <= 0", () => {
    const r = makeRecorder();
    const p = new ChildPing({
      pingMs: 0,
      timeoutMs: 500,
      maxConsecutiveFailures: 3,
      deps: r.deps,
    });
    p.start();
    vi.advanceTimersByTime(60_000);
    expect(r.sends).toHaveLength(0);
    expect(p._statsForTest().running).toBe(false);
    p.stop();
  });

  it("stop() is idempotent and clears any pending ping state", () => {
    const r = makeRecorder();
    const p = new ChildPing({
      pingMs: 1_000,
      timeoutMs: 500,
      maxConsecutiveFailures: 3,
      deps: r.deps,
    });
    p.start();
    vi.advanceTimersByTime(1_000);
    expect(p._statsForTest().pendingId).not.toBeNull();
    p.stop();
    expect(p._statsForTest().pendingId).toBeNull();
    p.stop(); // idempotent
    expect(p._statsForTest().running).toBe(false);
  });
});
