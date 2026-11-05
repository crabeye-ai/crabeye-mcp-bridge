import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const launches = vi.hoisted(() => [] as Array<{ command: string; args: string[] }>);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (command: string, args: string[]) => {
    launches.push({ command, args });
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    setImmediate(() => child.emit("spawn"));
    return child;
  },
}));

const { openBrowser } = await import("../../src/oauth/browser.js");
const { windowsPowerShellPath } = await import("../../src/process/process-utils.js");

describe("openBrowser", () => {
  it("starts PowerShell from System32 on Windows", async () => {
    const url = "https://auth.example/authorize?client_id=a";

    await expect(openBrowser(url, { _platform: "win32" })).resolves.toBe(true);

    expect(launches).toEqual([
      { command: windowsPowerShellPath(), args: ["-NoProfile", "-Command", "Start-Process", url] },
    ]);
  });
});
