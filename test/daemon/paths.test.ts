import { describe, it, expect } from "vitest";
import {
  getDaemonRunDir,
  getDaemonSocketPath,
  getDaemonPidPath,
  getDaemonLockPath,
} from "../../src/daemon/paths.js";

describe("daemon paths", () => {
  it("run dir is under ~/.crabeye/run on Unix", () => {
    if (process.platform === "win32") return;
    const dir = getDaemonRunDir();
    expect(dir).toMatch(/\.crabeye\/run$/);
  });

  it("socket path is manager.sock under run dir on Unix", () => {
    if (process.platform === "win32") return;
    expect(getDaemonSocketPath()).toBe(`${getDaemonRunDir()}/manager.sock`);
  });

  it("socket path is a named-pipe path on Windows", () => {
    if (process.platform !== "win32") return;
    expect(getDaemonSocketPath()).toMatch(/^\\\\\.\\pipe\\crabeye-mcp-bridge-manager-/);
  });

  it("pid and lock filenames are stable", () => {
    expect(getDaemonPidPath().endsWith("manager.pid")).toBe(true);
    expect(getDaemonLockPath().endsWith("manager.lock")).toBe(true);
  });
});
