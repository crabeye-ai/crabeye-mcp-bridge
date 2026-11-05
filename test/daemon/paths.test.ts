import { describe, it, expect, afterEach, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  daemonFilesFor,
  getDaemonRunDir,
  getDaemonSocketPath,
  getDaemonPidPath,
  getDaemonLockPath,
  getDaemonLogPath,
  getDaemonKeyPath,
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

  it("pid, lock and key filenames are stable", () => {
    expect(getDaemonPidPath().endsWith("manager.pid")).toBe(true);
    expect(getDaemonLockPath().endsWith("manager.lock")).toBe(true);
    expect(getDaemonKeyPath()).toBe(join(getDaemonRunDir(), "manager.key"));
  });

  describe("pipe name on Windows", () => {
    const platform = process.platform;

    afterEach(() => {
      vi.unstubAllEnvs();
      Object.defineProperty(process, "platform", { value: platform });
    });

    function pipeFor(localAppData: string): string {
      Object.defineProperty(process, "platform", { value: "win32" });
      vi.stubEnv("LOCALAPPDATA", localAppData);
      return getDaemonSocketPath();
    }

    it("ends with a hash of the run dir, so each profile gets its own manager", () => {
      const pipe = pipeFor("C:\\Users\\me\\AppData\\Local");

      expect(pipe).toMatch(/^\\\\\.\\pipe\\crabeye-mcp-bridge-manager-[A-Za-z0-9_-]+-[0-9a-f]{12}$/);
      expect(pipeFor("C:\\Users\\other\\AppData\\Local")).not.toBe(pipe);
    });

    it("is the same for a run dir spelled in another case", () => {
      expect(pipeFor("C:\\Users\\Me\\AppData\\Local")).toBe(pipeFor("c:\\users\\me\\appdata\\local"));
    });
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

  describe("log file", () => {
    const platform = process.platform;
    const localAppData = process.env.LOCALAPPDATA;

    afterEach(() => {
      Object.defineProperty(process, "platform", { value: platform });
      if (localAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = localAppData;
    });

    it("is ~/.crabeye/logs/daemon.log on macOS and Linux", () => {
      Object.defineProperty(process, "platform", { value: "darwin" });
      expect(getDaemonLogPath()).toBe(join(homedir(), ".crabeye", "logs", "daemon.log"));
      Object.defineProperty(process, "platform", { value: "linux" });
      expect(getDaemonLogPath()).toBe(join(homedir(), ".crabeye", "logs", "daemon.log"));
    });

    it("is under %LOCALAPPDATA%\\crabeye\\logs on Windows", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      process.env.LOCALAPPDATA = join("X", "AppData", "Local");
      expect(getDaemonLogPath()).toBe(join("X", "AppData", "Local", "crabeye", "logs", "daemon.log"));
    });

    it("falls back to the home directory's AppData on Windows without LOCALAPPDATA", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      delete process.env.LOCALAPPDATA;
      expect(getDaemonLogPath()).toBe(join(homedir(), "AppData", "Local", "crabeye", "logs", "daemon.log"));
    });
  });
});
