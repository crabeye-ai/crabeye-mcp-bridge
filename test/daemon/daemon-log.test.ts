import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonLogger } from "../../src/daemon/daemon-log.js";
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
});
