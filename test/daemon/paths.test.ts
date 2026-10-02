import { describe, it, expect, afterEach } from "vitest";
import {
  daemonFilesFor,
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

  describe("daemon files for a socket", () => {
    const platform = process.platform;

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: platform });
    });

    it("sit next to the socket on Unix", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });

      expect(daemonFilesFor("/tmp/run/manager.sock")).toEqual({
        lockPath: "/tmp/run/manager.lock",
        pidPath: "/tmp/run/manager.pid",
      });
    });

    it("use the standard run dir on Windows, where the socket is a named pipe", () => {
      Object.defineProperty(process, "platform", { value: "win32" });

      expect(daemonFilesFor("\\\\.\\pipe\\crabeye-mcp-bridge-manager-me")).toEqual({
        lockPath: getDaemonLockPath(),
        pidPath: getDaemonPidPath(),
      });
    });
  });
});
