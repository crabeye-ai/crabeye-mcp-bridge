import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runDir = vi.hoisted(() => ({ path: "" }));

vi.mock("../../src/daemon/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/daemon/index.js")>()),
  getDaemonSocketPath: () => join(runDir.path, "manager.sock"),
}));

vi.mock("../../src/process/process-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/process/process-utils.js")>()),
  readProcessInfo: async () => null,
}));

const { runDaemonCommand } = await import("../../src/commands/daemon.js");
const { encodeFrame, FrameDecoder } = await import("../../src/daemon/protocol.js");
const { waitForExit } = await import("../../src/daemon/daemon-process.js");
const { processExists } = await import("../../src/process/process-utils.js");

describe.skipIf(process.platform === "win32")("daemon stop", () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const child of children.splice(0)) child.kill("SIGKILL");
    rmSync(runDir.path, { recursive: true, force: true });
  });

  function captureStderr(): () => string {
    let out = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    return () => out;
  }

  it("stops a recorded process whose identity cannot be read, since only a confirmed foreign one is left alone", async () => {
    runDir.path = mkdtempSync("/tmp/cbe-stopu-");
    const unidentified = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
    children.push(unidentified);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(runDir.path, "manager.pid"), `${unidentified.pid}\n`);
    const stderr = captureStderr();

    expect(await runDaemonCommand("stop")).toBe(0);

    expect(stderr()).toBe(`unresponsive daemon ${unidentified.pid} stopped\n`);
    expect(await waitForExit(unidentified.pid!, 3_000)).toBe(true);
    expect(processExists(unidentified.pid!)).toBe(false);
  }, 15_000);

  it("says the daemon is not running when nothing is recorded", async () => {
    runDir.path = mkdtempSync("/tmp/cbe-stopu-");
    const stderr = captureStderr();

    expect(await runDaemonCommand("stop")).toBe(0);

    expect(stderr()).toBe("daemon not running\n");
  });

  it("reports a recorded process it could not stop", async () => {
    runDir.path = mkdtempSync("/tmp/cbe-stopu-");
    const stubborn = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
    children.push(stubborn);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(join(runDir.path, "manager.pid"), `${stubborn.pid}\n`);
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === stubborn.pid && signal !== 0 && signal !== undefined) {
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      }
      return realKill(pid, signal);
    });
    const stderr = captureStderr();

    expect(await runDaemonCommand("stop")).toBe(0);

    expect(stderr()).toMatch(new RegExp(`^could not stop pid ${stubborn.pid} recorded for the daemon$`, "m"));
  });

  it("says the daemon stopped when it shuts down cleanly", async () => {
    runDir.path = mkdtempSync("/tmp/cbe-stopu-");
    const daemon = createServer((sock: Socket) => {
      const decoder = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
          sock.write(encodeFrame({ id: (frame as { id?: string }).id, result: { ok: true } }));
        }
      });
    });
    await new Promise<void>((r) => daemon.listen(join(runDir.path, "manager.sock"), () => r()));
    const stderr = captureStderr();

    try {
      expect(await runDaemonCommand("stop")).toBe(0);
    } finally {
      await new Promise<void>((r) => daemon.close(() => r()));
    }

    expect(stderr()).toBe("daemon stopped\n");
  });
});
