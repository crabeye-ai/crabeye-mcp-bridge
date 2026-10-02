import { describe, it, expect, vi } from "vitest";

const processInfo = vi.hoisted(() => ({ cmdline: "" as string | null }));

vi.mock("../../src/process/process-utils.js", () => ({
  readProcessInfo: async () =>
    processInfo.cmdline === null ? null : { cmdline: processInfo.cmdline, startTime: null },
}));

const { isForeignProcess } = await import("../../src/daemon/daemon-identity.js");

describe("daemon identity when the command line can't be read", () => {
  it.each([
    ["unreadable process", null],
    ["blank command line (e.g. another Windows session)", ""],
  ])("keeps the lock for a %s", async (_label, cmdline) => {
    processInfo.cmdline = cmdline;

    expect(await isForeignProcess(1234)).toBe(false);
  });
});
