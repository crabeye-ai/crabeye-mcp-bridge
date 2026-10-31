import { describe, it, expect } from "vitest";
import { Telemetry, type KilledReason } from "../../src/daemon/telemetry.js";

describe("Telemetry", () => {
  it("snapshot starts at zero", () => {
    const t = new Telemetry();
    expect(t.snapshot()).toEqual({
      children: {
        total: 0,
        spawnedTotal: 0,
        killedTotal: { grace: 0, restart: 0, crash: 0, wedged: 0 },
      },
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

    it("recordStop decrements total and increments killedTotal[reason]", () => {
      const t = new Telemetry();
      t.recordSpawn();
      t.recordSpawn();
      t.recordStop("grace");
      t.recordStop("restart");
      const s = t.snapshot();
      expect(s.children.total).toBe(0);
      expect(s.children.spawnedTotal).toBe(2);
      expect(s.children.killedTotal).toEqual({ grace: 1, restart: 1, crash: 0, wedged: 0 });
    });

    it("recordStop never drops total below zero", () => {
      const t = new Telemetry();
      t.recordStop("crash");
      expect(t.snapshot().children.total).toBe(0);
      expect(t.snapshot().children.killedTotal.crash).toBe(1);
    });

    it("lowers total without counting a kill for a stop that isn't one", () => {
      const t = new Telemetry();
      t.recordSpawn();
      t.recordStop(null);
      expect(t.snapshot().children).toEqual({ total: 0, spawnedTotal: 1, killedTotal: { grace: 0, restart: 0, crash: 0, wedged: 0 } });
    });

    it("counts each reason independently", () => {
      const t = new Telemetry();
      const reasons: KilledReason[] = ["grace", "grace", "restart", "crash", "crash", "crash"];
      for (const r of reasons) t.recordStop(r);
      expect(t.snapshot().children.killedTotal).toEqual({ grace: 2, restart: 1, crash: 3, wedged: 0 });
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
      t.recordRpcError("unknown_method");
      expect(t.snapshot().rpc.errorsTotal).toEqual({
        invalid_params: 2,
        unknown_method: 1,
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
});
