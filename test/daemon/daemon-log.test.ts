import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonLogger, routeConsoleTo } from "../../src/daemon/daemon-log.js";
import { DAEMON_LOG_MAX_BYTES } from "../../src/constants.js";

describe("createDaemonLogger", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbe-daemon-log-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("keeps the documented 10 MB limit", () => {
    expect(DAEMON_LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
  });

  it("writes dated lines with the daemon's pid at the configured level, and rotates past the limit", () => {
    const path = join(root, "logs", "daemon.log");
    const logger = createDaemonLogger({ level: "info", path, maxBytes: 100 });

    logger.debug("hidden", { component: "daemon" });
    logger.info("first line", { component: "daemon" });
    logger.info("second line", { component: "daemon" });

    const rotated = readFileSync(`${path}.1`, "utf8");
    const current = readFileSync(path, "utf8");
    expect(rotated).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\S+ \\[${process.pid}\\] INFO  \\[daemon\\] first line\\n$`));
    expect(current).toMatch(/INFO  \[daemon\] second line\n$/);
    expect(rotated + current).not.toContain("hidden");
  });

  it("writes what the manager prints through console to the log at matching levels, escaped, until the console is put back", () => {
    const path = join(root, "daemon.log");
    const logger = createDaemonLogger({ level: "debug", path });
    const restore = routeConsoleTo(logger.child({ component: "console" }));
    try {
      console.warn("[mcp-sdk] excluding tool '%s'", "a\u001b[31mb");
      console.error(new Error("failed"));
      console.log("plain %d", 2);
      console.info("info");
      console.debug("detail");
    } finally {
      restore();
    }
    console.info("after restore");

    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    expect(lines.map((line) => line.replace(/^\S+ \[\d+\] /, ""))).toEqual([
      "WARN  [console] [mcp-sdk] excluding tool 'a\\x1b[31mb'",
      expect.stringMatching(/^ERROR \[console\] Error: failed\\n {4}at /),
      "INFO  [console] plain 2",
      "INFO  [console] info",
      "DEBUG [console] detail",
    ]);
  });
});
