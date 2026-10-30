import { describe, it, expect } from "vitest";
import { CONNECTION_STATUSES } from "../../src/upstream/types.js";
import {
  encodeFrame,
  FrameDecoder,
  FrameError,
  MAX_FRAME_BYTES,
  MIN_BRIDGE_PROTOCOL_VERSION,
  MIN_DAEMON_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  UNREPORTED_BRIDGE_PROTOCOL_VERSION,
  notImplementedResponse,
  ERROR_CODE_UPSTREAM_RESTARTED,
  INNER_ERROR_CODE_UPSTREAM_RESTARTED,
  type SessionEvictedParams,
  type DaemonMethod,
  type UpstreamRestartedReason,
  type RestartParams,
  type RestartResult,
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

    it("decodes a large frame that arrives in many chunks, with the next frame's start in the last one", () => {
      const big = encodeFrame({ text: "x".repeat(1_000_000) });
      const next = encodeFrame({ n: 2 });
      const stream = Buffer.concat([big, next.subarray(0, 2)]);
      const dec = new FrameDecoder();
      for (let at = 0; at < stream.length; at += 65_536) {
        expect(dec.next()).toBeNull();
        dec.push(stream.subarray(at, at + 65_536));
      }
      expect(dec.next()).toEqual({ text: "x".repeat(1_000_000) });
      expect(dec.next()).toBeNull();
      dec.push(next.subarray(2));
      expect(dec.next()).toEqual({ n: 2 });
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

    it("speaks protocol 3 and needs a daemon that does, while still accepting bridges from protocol 1", () => {
      expect(PROTOCOL_VERSION).toBe(3);
      expect(MIN_DAEMON_PROTOCOL_VERSION).toBe(3);
      expect([MIN_BRIDGE_PROTOCOL_VERSION, UNREPORTED_BRIDGE_PROTOCOL_VERSION]).toEqual([1, 1]);
    });
  });

  describe("protocol — SESSION_EVICTED", () => {
    it("typechecks SESSION_EVICTED method and params", () => {
      const m: DaemonMethod = "SESSION_EVICTED";
      const p: SessionEvictedParams = {
        sessionId: "11111111-1111-1111-1111-111111111111",
        reason: "child_exited",
      };
      expect(m).toBe("SESSION_EVICTED");
      expect(p.reason).toBe("child_exited");
    });
  });

  describe("protocol — Phase E additions", () => {
    it("exports ERROR_CODE_UPSTREAM_RESTARTED with the literal value", () => {
      expect(ERROR_CODE_UPSTREAM_RESTARTED).toBe("upstream_restarted");
    });

    it("exports INNER_ERROR_CODE_UPSTREAM_RESTARTED with the numeric literal", () => {
      expect(INNER_ERROR_CODE_UPSTREAM_RESTARTED).toBe(-32004);
    });

    it("typechecks both upstream-restarted reasons", () => {
      const a: UpstreamRestartedReason = "admin_restart";
      const b: UpstreamRestartedReason = "daemon_respawn";
      expect([a, b]).toEqual(["admin_restart", "daemon_respawn"]);
    });

    it("typechecks RestartParams + RestartResult", () => {
      const p: RestartParams = { upstreamHash: "deadbeef" };
      const r: RestartResult = { ok: true, killed: 1 };
      expect(p.upstreamHash).toBe("deadbeef");
      expect(r.killed).toBe(1);
    });

    it("includes PING in DaemonMethod union", () => {
      const m: DaemonMethod = "PING";
      expect(m).toBe("PING");
    });
  });

  it("reports only the upstream states bridges of this protocol version know; another one needs a protocol version bump", () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(CONNECTION_STATUSES).toEqual(["disconnected", "connecting", "connected", "auth_required"]);
  });
});
