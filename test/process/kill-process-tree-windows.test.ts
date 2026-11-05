import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn as realSpawn, type ChildProcess } from "node:child_process";

const taskkills = vi.hoisted(() => [] as Array<{ command: string; args: string[]; options: unknown }>);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (command: string, args: string[], options: unknown, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
    taskkills.push({ command, args, options });
    callback(null, "", "");
  },
}));

const { killProcessTree, system32Path } = await import("../../src/process/process-utils.js");

describe.skipIf(process.platform === "win32")("killProcessTree on Windows", () => {
  const platform = process.platform;
  let target: ChildProcess | undefined;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    target?.kill("SIGKILL");
  });

  it("runs taskkill from System32 without a console window", async () => {
    target = realSpawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
    Object.defineProperty(process, "platform", { value: "win32" });

    await killProcessTree(target.pid!, { gracefulMs: 0, forceMs: 0 });

    expect(taskkills).toEqual([
      { command: system32Path("taskkill.exe"), args: ["/PID", String(target.pid), "/T", "/F"], options: expect.objectContaining({ windowsHide: true }) },
    ]);
  });
});
