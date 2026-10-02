import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
  reads: 0,
  afterGrace: { cmdline: "/usr/bin/some-other-program", startTime: 2 } as { cmdline: string; startTime: number },
}));

vi.mock("../../src/process/process-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/process/process-utils.js")>()),
  readProcessInfo: async () =>
    ++identity.reads === 1 ? { cmdline: "node index.js daemon --internal-launch", startTime: 1 } : identity.afterGrace,
}));

const { terminateDaemon } = await import("../../src/daemon/daemon-process.js");
const { processExists } = await import("../../src/process/process-utils.js");

describe.skipIf(process.platform === "win32")("terminateDaemon when the pid changes hands during the grace period", () => {
  const children: ChildProcess[] = [];

  beforeEach(() => {
    identity.reads = 0;
  });

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });

  async function startIgnoringSigterm(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e6)"], {
      stdio: "ignore",
    });
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    return child.pid!;
  }

  it("does not escalate to SIGKILL once the pid no longer belongs to a daemon", async () => {
    identity.afterGrace = { cmdline: "/usr/bin/some-other-program", startTime: 2 };
    const pid = await startIgnoringSigterm();

    expect(await terminateDaemon(pid, { graceMs: 300, startTime: 1 })).toBe("not_ours");

    expect(processExists(pid)).toBe(true);
  });

  it("does not escalate when a different daemon took the pid, even without a pinned start time", async () => {
    identity.afterGrace = { cmdline: "node index.js daemon --internal-launch", startTime: 2 };
    const pid = await startIgnoringSigterm();

    expect(await terminateDaemon(pid, { graceMs: 300, allowUnidentified: true })).toBe("not_ours");

    expect(processExists(pid)).toBe(true);
  });
});
