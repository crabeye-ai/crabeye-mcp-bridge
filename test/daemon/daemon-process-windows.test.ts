import { spawn as realSpawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const taskkill = vi.hoisted(() => ({ calls: [] as string[][], exitCode: 0 }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...actual,
    spawn: (command: string, args: string[], options?: object) => {
      if (command !== "taskkill") return actual.spawn(command, args, options ?? {});
      taskkill.calls.push([command, ...args]);
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", taskkill.exitCode));
      return child;
    },
  };
});

vi.mock("../../src/process/process-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/process/process-utils.js")>()),
  readProcessInfo: async () => ({ cmdline: "node index.js daemon --internal-launch", startTime: 1 }),
}));

const { terminateDaemon } = await import("../../src/daemon/daemon-process.js");

describe.skipIf(process.platform === "win32")("terminateDaemon on Windows", () => {
  const platform = process.platform;
  let daemon: ChildProcess;

  beforeEach(async () => {
    daemon = realSpawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    Object.defineProperty(process, "platform", { value: "win32" });
    taskkill.calls = [];
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    vi.restoreAllMocks();
    daemon.kill("SIGKILL");
  });

  it("force-kills through taskkill instead of signals", async () => {
    const kill = vi.spyOn(process, "kill");
    taskkill.exitCode = 0;

    expect(await terminateDaemon(daemon.pid!, { graceMs: 2_000 })).toBe("terminated");

    expect(taskkill.calls).toEqual([["taskkill", "/F", "/PID", String(daemon.pid)]]);
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0 && signal !== undefined)).toEqual([]);
  });

  it("reports failure when taskkill does", async () => {
    taskkill.exitCode = 128;

    expect(await terminateDaemon(daemon.pid!, { graceMs: 0 })).toBe("failed");
  });
});
