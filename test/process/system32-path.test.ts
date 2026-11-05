import { afterEach, describe, expect, it, vi } from "vitest";
import { system32Path, windowsPowerShellPath } from "../../src/process/process-utils.js";

describe("system32Path", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the path under SystemRoot", () => {
    vi.stubEnv("SystemRoot", "D:\\Win");

    expect(system32Path("taskkill.exe")).toBe("D:\\Win\\System32\\taskkill.exe");
    expect(windowsPowerShellPath()).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it.each([["unset", undefined], ["empty", ""]])("falls back to C:\\Windows when SystemRoot is %s", (_label, value) => {
    vi.stubEnv("SystemRoot", value);

    expect(system32Path("taskkill.exe")).toBe("C:\\Windows\\System32\\taskkill.exe");
  });
});
