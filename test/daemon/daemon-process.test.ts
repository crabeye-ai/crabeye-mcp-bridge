import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeProcess, isSameProcess, terminateDaemon, waitForExit } from "../../src/daemon/daemon-process.js";
import { parsePid, processExists } from "../../src/process/process-utils.js";

const IGNORES_SIGTERM = `process.on("SIGTERM", () => {}); setInterval(() => {}, 1e6);`;
const EXITS_ON_SIGTERM = `process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1e6);`;

describe.skipIf(process.platform === "win32")("daemon process helpers", () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });

  async function start(script: string, asDaemon: boolean): Promise<number> {
    const child = spawn(process.execPath, ["-e", script, ...(asDaemon ? ["daemon", "--internal-launch"] : [])], {
      stdio: "ignore",
    });
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    return child.pid!;
  }

  it("stops a daemon that exits on SIGTERM without escalating", async () => {
    const pid = await start(EXITS_ON_SIGTERM, true);

    expect(await terminateDaemon(pid, { graceMs: 2_000 })).toBe("terminated");

    expect(await waitForExit(pid, 1_000)).toBe(true);
  });

  it("escalates to SIGKILL when a daemon ignores SIGTERM past the grace period", async () => {
    const pid = await start(IGNORES_SIGTERM, true);
    const startedAt = Date.now();

    expect(await terminateDaemon(pid, { graceMs: 300 })).toBe("terminated");

    expect(await waitForExit(pid, 1_000)).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
  });

  it("refuses to signal a process that is not a daemon", async () => {
    const pid = await start(IGNORES_SIGTERM, false);

    expect(await terminateDaemon(pid, { graceMs: 0 })).toBe("not_ours");

    expect(processExists(pid)).toBe(true);
  });

  it("refuses to signal a daemon whose start time no longer matches the one pinned", async () => {
    const pid = await start(IGNORES_SIGTERM, true);
    const pinned = await describeProcess(pid);

    expect(await terminateDaemon(pid, { graceMs: 0, startTime: (pinned!.startTime ?? 0) + 60_000 })).toBe("not_ours");

    expect(processExists(pid)).toBe(true);
  });

  it("counts a daemon that exits just before the kill as terminated", async () => {
    const pid = await start(IGNORES_SIGTERM, true);
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((target, signal) => {
      if (signal === "SIGKILL") throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return realKill(target, signal);
    });

    try {
      expect(await terminateDaemon(pid, { graceMs: 0 })).toBe("terminated");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("counts a daemon that is already gone as terminated", async () => {
    const pid = await start(EXITS_ON_SIGTERM, true);
    process.kill(pid, "SIGKILL");
    await waitForExit(pid, 1_000);

    expect(await terminateDaemon(pid, { graceMs: 0 })).toBe("terminated");
  });

  it("refuses to signal itself", async () => {
    expect(await terminateDaemon(process.pid, { graceMs: 0 })).toBe("not_ours");
  });

  it("identifies a running process by pid and start time, and nothing for a dead pid", async () => {
    const pid = await start(IGNORES_SIGTERM, false);
    const first = await describeProcess(pid);
    const again = await describeProcess(pid);

    expect(first).not.toBeNull();
    expect(isSameProcess(first!, again!)).toBe(true);
    expect(isSameProcess(first!, { pid, startTime: (first!.startTime ?? 0) + 1 })).toBe(false);
    expect(isSameProcess(first!, { pid, startTime: null })).toBe(true);
    expect(isSameProcess(first!, { pid: pid + 1, startTime: null })).toBe(false);
    process.kill(pid, "SIGKILL");
    await waitForExit(pid, 1_000);
    expect(await describeProcess(pid)).toBeNull();
  });

  it("reports when a process outlives the wait", async () => {
    const pid = await start(IGNORES_SIGTERM, false);

    expect(await waitForExit(pid, 100)).toBe(false);
  });

  it.each([
    ["123\n", 123],
    ["123\ntoken\n", 123],
    ["", null],
    ["0", null],
    ["-4", null],
    ["abc", null],
  ])("parses the pid from %j", (text, expected) => {
    expect(parsePid(text)).toBe(expected);
  });
});
