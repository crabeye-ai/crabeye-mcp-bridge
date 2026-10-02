import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/process/process-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/process/process-utils.js")>()),
  readProcessInfo: async () => null,
}));

const { terminateDaemon, waitForExit } = await import("../../src/daemon/daemon-process.js");
const { processExists } = await import("../../src/process/process-utils.js");

describe.skipIf(process.platform === "win32")("terminateDaemon when a process's identity cannot be read", () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });

  async function startUnidentified(): Promise<number> {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    return child.pid!;
  }

  it("never signals it by default", async () => {
    const pid = await startUnidentified();

    expect(await terminateDaemon(pid, { graceMs: 0 })).toBe("not_ours");
    expect(processExists(pid)).toBe(true);
  });

  it("stops it when unidentified processes are allowed, as the manual stop command does", async () => {
    const pid = await startUnidentified();

    expect(await terminateDaemon(pid, { graceMs: 0, allowUnidentified: true })).toBe("terminated");
    expect(await waitForExit(pid, 1_000)).toBe(true);
  });
});
