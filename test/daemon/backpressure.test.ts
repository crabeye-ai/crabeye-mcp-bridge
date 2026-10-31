import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildHandle, BackpressureError } from "../../src/daemon/child-handle.js";

const isWindows = process.platform === "win32";
const STUB = resolve(fileURLToPath(import.meta.url), "..", "..", "fixtures", "stub-mcp-child.mjs");

describe.skipIf(isWindows)("ChildHandle backpressure", () => {
  it("throws BackpressureError when one frame exceeds queueMaxBytes", async () => {
    let exited = false;
    const child = new ChildHandle({
      command: process.execPath,
      args: [STUB],
      env: { ...process.env, STUB_HANG_ON_INIT: "1" },
      queueMaxBytes: 50,
      onMessage: () => {},
      onClose: () => {
        exited = true;
      },
      onError: () => {},
    });

    // First call: payload ≈ 200+ bytes, far above the 50-byte cap.
    expect(() =>
      child.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "1" } },
      }),
    ).toThrow(BackpressureError);

    // Child still alive (we threw before writing anything).
    expect(exited).toBe(false);

    await child.kill(500);
  });
});
