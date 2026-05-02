import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import {
  isProcessAlive,
  killProcessTree,
  readProcessInfo,
} from "../src/process/process-utils.js";

const isWindows = process.platform === "win32";

describe("process-utils", () => {
  describe("isProcessAlive", () => {
    it("returns true for the current process", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for a definitely-gone PID", () => {
      // PID 0 is the kernel scheduler on Linux, "swapper" on BSD; signal 0
      // either succeeds (kernel) or returns ESRCH/EPERM. We use a high pid
      // that is essentially guaranteed to be free.
      expect(isProcessAlive(0x7fff_fffe)).toBe(false);
    });
  });

  describe("killProcessTree (POSIX integration)", () => {
    if (isWindows) {
      it.skip("Windows path is exercised via mocks", () => {});
      return;
    }

    it("kills a long-running subprocess and its descendants", async () => {
      // Spawn `sh -c 'sleep 60 & wait'` as its own process-group leader so
      // the group-kill path actually has a group to target. (Production
      // MCP children are spawned by the SDK without detached:true, in which
      // case killProcessTree falls back to direct-PID signalling.)
      const child = spawn("sh", ["-c", "sleep 60 & wait"], {
        detached: true,
        stdio: "ignore",
      });
      // Wait for spawn
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", reject);
      });
      const pid = child.pid!;
      expect(isProcessAlive(pid)).toBe(true);

      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });

      const dead = await killProcessTree(pid, {
        gracefulMs: 200,
        forceMs: 1000,
        pollMs: 20,
      });
      // killProcessTree returns true once the kernel reports the PID is
      // gone, but on POSIX the process can briefly remain as a zombie
      // until the parent (this test) reaps it via SIGCHLD. Wait for the
      // child_process 'close' event before asserting aliveness.
      expect(dead).toBe(true);
      await closed;
      expect(isProcessAlive(pid)).toBe(false);
    }, 10_000);

    it("returns true immediately for an already-dead PID", async () => {
      const dead = await killProcessTree(0x7fff_fffe, {
        gracefulMs: 50,
        forceMs: 50,
        pollMs: 10,
      });
      expect(dead).toBe(true);
    });
  });

  describe("readProcessInfo", () => {
    it("returns cmdline for the current process", async () => {
      const info = await readProcessInfo(process.pid);
      expect(info).not.toBeNull();
      expect(info!.cmdline.length).toBeGreaterThan(0);
      // Node typically appears in the cmdline of the test runner process.
      expect(info!.cmdline.toLowerCase()).toMatch(/node|vitest/);
    });

    it("returns startTime for the current process within plausible range", async () => {
      const info = await readProcessInfo(process.pid);
      expect(info).not.toBeNull();
      if (info!.startTime !== null) {
        // Should be in the past, no more than a day ago for a test process.
        const now = Date.now();
        expect(info!.startTime).toBeLessThanOrEqual(now);
        expect(info!.startTime).toBeGreaterThan(now - 24 * 3600_000);
      }
    });

    it("returns null for a non-existent PID", async () => {
      const info = await readProcessInfo(0x7fff_fffe);
      expect(info).toBeNull();
    });
  });
});
