import { describe, it, expect } from "vitest";
import { Telemetry, type KilledReason } from "../../src/daemon/telemetry.js";

describe("Telemetry", () => {
  it("snapshot starts at zero", () => {
    const t = new Telemetry();
    expect(t.snapshot()).toEqual({
      children: {
        total: 0,
        spawnedTotal: 0,
        killedTotal: { grace: 0, restart: 0, fork: 0, crash: 0 },
      },
      sessions: { total: 0, openedTotal: 0, closedTotal: 0 },
      fork: { eventsTotal: 0 },
      rpc: { inFlight: 0, errorsTotal: {} },
    });
  });

  describe("children", () => {
    it("recordSpawn increments total and spawnedTotal", () => {
      const t = new Telemetry();
      t.recordSpawn();
      t.recordSpawn();
      const s = t.snapshot();
      expect(s.children.total).toBe(2);
      expect(s.children.spawnedTotal).toBe(2);
    });

    it("recordKill decrements total and increments killedTotal[reason]", () => {
      const t = new Telemetry();
      t.recordSpawn();
      t.recordSpawn();
      t.recordKill("grace");
      t.recordKill("restart");
      const s = t.snapshot();
      expect(s.children.total).toBe(0);
      expect(s.children.spawnedTotal).toBe(2);
      expect(s.children.killedTotal).toEqual({ grace: 1, restart: 1, fork: 0, crash: 0 });
    });

    it("recordKill never drops total below zero", () => {
      const t = new Telemetry();
      t.recordKill("crash");
      expect(t.snapshot().children.total).toBe(0);
      expect(t.snapshot().children.killedTotal.crash).toBe(1);
    });

    it("counts each reason independently", () => {
      const t = new Telemetry();
      const reasons: KilledReason[] = ["grace", "grace", "restart", "fork", "crash", "crash", "crash"];
      for (const r of reasons) t.recordKill(r);
      expect(t.snapshot().children.killedTotal).toEqual({ grace: 2, restart: 1, fork: 1, crash: 3 });
    });
  });

  describe("sessions", () => {
    it("open/close updates total and lifetime counters", () => {
      const t = new Telemetry();
      t.recordSessionOpen();
      t.recordSessionOpen();
      t.recordSessionClose();
      const s = t.snapshot();
      expect(s.sessions.total).toBe(1);
      expect(s.sessions.openedTotal).toBe(2);
      expect(s.sessions.closedTotal).toBe(1);
    });

    it("close on empty floors total at zero", () => {
      const t = new Telemetry();
      t.recordSessionClose();
      expect(t.snapshot().sessions.total).toBe(0);
      expect(t.snapshot().sessions.closedTotal).toBe(1);
    });
  });

  describe("fork events", () => {
    it("recordForkEvent increments fork.eventsTotal", () => {
      const t = new Telemetry();
      t.recordForkEvent();
      t.recordForkEvent();
      t.recordForkEvent();
      expect(t.snapshot().fork.eventsTotal).toBe(3);
    });
  });

  describe("rpc gauges", () => {
    it("inflight inc/dec tracks live request count", () => {
      const t = new Telemetry();
      t.rpcInFlightInc();
      t.rpcInFlightInc();
      expect(t.snapshot().rpc.inFlight).toBe(2);
      t.rpcInFlightDec();
      expect(t.snapshot().rpc.inFlight).toBe(1);
    });

    it("inflight dec on zero is clamped (no negative)", () => {
      const t = new Telemetry();
      t.rpcInFlightDec();
      t.rpcInFlightDec();
      expect(t.snapshot().rpc.inFlight).toBe(0);
    });

    it("recordRpcError builds a per-code map", () => {
      const t = new Telemetry();
      t.recordRpcError("invalid_params");
      t.recordRpcError("invalid_params");
      t.recordRpcError("session_not_found");
      expect(t.snapshot().rpc.errorsTotal).toEqual({
        invalid_params: 2,
        session_not_found: 1,
      });
    });

    it("recordRpcError caps the number of distinct codes", () => {
      const t = new Telemetry();
      for (let i = 0; i < 200; i++) t.recordRpcError(`code_${i}`);
      const errorsTotal = t.snapshot().rpc.errorsTotal;
      // Cap is 64; at the cap, new keys are dropped but counts on existing keys still increment.
      expect(Object.keys(errorsTotal).length).toBeLessThanOrEqual(64);
      // Existing keys must still count up.
      t.recordRpcError("code_0");
      t.recordRpcError("code_0");
      expect(t.snapshot().rpc.errorsTotal.code_0).toBeGreaterThanOrEqual(3);
    });
  });

  describe("snapshot independence", () => {
    it("snapshot does not share map reference with internal state", () => {
      const t = new Telemetry();
      t.recordRpcError("foo");
      const s1 = t.snapshot();
      t.recordRpcError("foo");
      // Mutating after a snapshot must not retroactively change it.
      expect(s1.rpc.errorsTotal.foo).toBe(1);
      expect(t.snapshot().rpc.errorsTotal.foo).toBe(2);
    });

    it("snapshot copies killedTotal record", () => {
      const t = new Telemetry();
      t.recordKill("grace");
      const s1 = t.snapshot();
      t.recordKill("grace");
      expect(s1.children.killedTotal.grace).toBe(1);
      expect(t.snapshot().children.killedTotal.grace).toBe(2);
    });
  });
});
