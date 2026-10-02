import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import {
  DAEMON_LAUNCH_ARGS,
  isDaemonCommandLine,
  isForeignProcess,
} from "../../src/daemon/daemon-identity.js";

describe("daemon identity", () => {
  it.each([
    ["/usr/local/bin/node /x/dist/index.js daemon --internal-launch", true],
    ["/usr/bin/nodejs /x/dist/index.js daemon --internal-launch", true],
    ['"C:\\Program Files\\nodejs\\node.exe" "C:\\x\\index.js" daemon --internal-launch', true],
    ["node /home/me/.npm/_npx/abc/node_modules/.bin/crabeye-mcp-bridge daemon start", false],
    ["node /home/me/.npm/_npx/abc/node_modules/.bin/crabeye-mcp-bridge --config c.json", false],
    ["vim /home/me/crabeye-mcp-bridge/src/commands/daemon.ts", false],
    ["node /opt/claude-flow/cli.js daemon start", false],
    ["/usr/sbin/sshd -D", false],
  ])("%s → daemon: %s", (cmdline, expected) => {
    expect(isDaemonCommandLine(cmdline)).toBe(expected);
  });

  it("recognizes the command line the daemon is actually launched with", () => {
    expect(isDaemonCommandLine([process.execPath, "/x/dist/index.js", ...DAEMON_LAUNCH_ARGS].join(" "))).toBe(true);
  });

  it("treats an unrelated live process as foreign and a crabeye daemon as ours", async () => {
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const daemonLike = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "daemon", "--internal-launch"]);
    try {
      await new Promise((r) => setTimeout(r, 100));
      expect(await isForeignProcess(unrelated.pid!)).toBe(true);
      expect(await isForeignProcess(daemonLike.pid!)).toBe(false);
    } finally {
      unrelated.kill();
      daemonLike.kill();
    }
  });
});
