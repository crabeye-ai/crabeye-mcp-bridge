import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  FrameDecoder,
  FrameError,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  notImplementedResponse,
  ERROR_CODE_AUTO_FORK_INITIALIZE_FAILED,
  INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT,
  INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE,
  type SessionEvictedParams,
  type DaemonMethod,
} from "../../src/daemon/protocol.js";

describe("daemon protocol", () => {
  describe("frame encode/decode round-trip", () => {
    it("decodes a single complete frame", () => {
      const frame = encodeFrame({ id: "1", method: "STATUS" });
      const dec = new FrameDecoder();
      dec.push(frame);
      expect(dec.next()).toEqual({ id: "1", method: "STATUS" });
      expect(dec.next()).toBeNull();
    });

    it("decodes two concatenated frames", () => {
      const a = encodeFrame({ id: "a" });
      const b = encodeFrame({ id: "b" });
      const dec = new FrameDecoder();
      dec.push(Buffer.concat([a, b]));
      expect(dec.next()).toEqual({ id: "a" });
      expect(dec.next()).toEqual({ id: "b" });
      expect(dec.next()).toBeNull();
    });

    it("tolerates split header", () => {
      const frame = encodeFrame({ x: 1 });
      const dec = new FrameDecoder();
      // Push 1 byte at a time of the 4-byte header.
      for (let i = 0; i < 4; i++) {
        dec.push(frame.subarray(i, i + 1));
        expect(dec.next()).toBeNull();
      }
      // Push the body in chunks.
      dec.push(frame.subarray(4, 6));
      expect(dec.next()).toBeNull();
      dec.push(frame.subarray(6));
      expect(dec.next()).toEqual({ x: 1 });
    });

    it("decodes a back-to-back stream of frames in order", () => {
      const a = encodeFrame({ n: 1 });
      const b = encodeFrame({ n: 2 });
      const c = encodeFrame({ n: 3 });
      const dec = new FrameDecoder();
      dec.push(Buffer.concat([a, b, c]));
      const out: unknown[] = [];
      for (;;) {
        const m = dec.next();
        if (m === null) break;
        out.push(m);
      }
      expect(out).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    });
  });

  describe("frame errors", () => {
    it("rejects oversized declared length", () => {
      const dec = new FrameDecoder();
      const header = Buffer.alloc(4);
      header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
      dec.push(header);
      expect(() => dec.next()).toThrow(FrameError);
    });

    it("recovers (does not stick) after an oversize-header throw", () => {
      const dec = new FrameDecoder();
      const header = Buffer.alloc(4);
      header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
      dec.push(header);
      expect(() => dec.next()).toThrow(FrameError);
      // Buffer was discarded; subsequent next() returns null instead of
      // re-throwing the same error forever.
      expect(dec.next()).toBeNull();
      // And the decoder is usable again with a fresh frame.
      dec.push(encodeFrame({ ok: true }));
      expect(dec.next()).toEqual({ ok: true });
    });

    it("rejects pre-header overflow (slow drip-feed of garbage)", () => {
      const dec = new FrameDecoder();
      const chunk = Buffer.alloc(9 * 1024 * 1024); // 9 MiB
      dec.push(chunk);
      // 9 MiB + 9 MiB = 18 MiB, well past MAX_FRAME_BYTES (16 MiB) + header.
      expect(() => dec.push(chunk)).toThrow(FrameError);
    });

    it("throws on invalid JSON payload", () => {
      const payload = Buffer.from("not-json", "utf-8");
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length, 0);
      const dec = new FrameDecoder();
      dec.push(Buffer.concat([header, payload]));
      expect(() => dec.next()).toThrow(FrameError);
    });

    it("rejects payload over max on encode", () => {
      // Fabricate a payload guaranteed larger than the cap by repeating a
      // big string. Use ~17 MiB.
      const big = "x".repeat(17 * 1024 * 1024);
      expect(() => encodeFrame({ big })).toThrow(FrameError);
    });
  });

  describe("response helpers", () => {
    it("not_implemented carries the method name", () => {
      const r = notImplementedResponse("42", "RPC");
      expect(r.id).toBe("42");
      expect(r.error?.code).toBe("not_implemented");
      expect(r.error?.message).toContain("RPC");
    });

    it("PROTOCOL_VERSION is a positive int", () => {
      expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
      expect(PROTOCOL_VERSION).toBeGreaterThan(0);
    });
  });

  describe("protocol — Phase D additions", () => {
    it("exports auto-fork error codes with correct shapes", () => {
      expect(ERROR_CODE_AUTO_FORK_INITIALIZE_FAILED).toBe("auto_fork_initialize_failed");
      expect(INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT).toBe(-32002);
      expect(INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE).toBe(-32003);
    });

    it("typechecks SESSION_EVICTED method and params", () => {
      const m: DaemonMethod = "SESSION_EVICTED";
      const p: SessionEvictedParams = {
        sessionId: "11111111-1111-1111-1111-111111111111",
        reason: "auto_fork_drain_timeout",
      };
      expect(m).toBe("SESSION_EVICTED");
      expect(p.reason).toBe("auto_fork_drain_timeout");
    });
  });
});
