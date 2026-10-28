import { afterEach, describe, expect, it, vi } from "vitest";
import { DAEMON_SHUTDOWN_MARGIN_MS } from "../../src/constants.js";
import { daemonStopBudgetMs, installCrashHandlers, installSignalHandlers, type Stoppable } from "../../src/daemon/process-handlers.js";
import { spyLogger } from "../_helpers/spy-logger.js";

const stoppable = (stop: Stoppable["stop"] = async () => {}) => ({ stop: vi.fn(stop) });

describe("installCrashHandlers", () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    vi.useRealTimers();
  });

  function install(target: Stoppable, watchdogMs = 1_000) {
    const logger = spyLogger();
    const exit = vi.fn();
    uninstall = installCrashHandlers({ logger, target, watchdogMs, exit });
    return { logger, exit };
  }

  it("logs the stack and stops the daemon with exit code 1 and the reason", () => {
    const target = stoppable();
    const { logger, exit } = install(target);

    process.emit("uncaughtException", new Error("boom"), "uncaughtException");

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/^uncaughtException: Error: boom\n\s+at /));
    expect(target.stop).toHaveBeenCalledWith(1, "crashed: boom");
    expect(exit).not.toHaveBeenCalled();
  });

  it("treats an unhandled rejection the same way", () => {
    const target = stoppable();
    const { logger } = install(target);

    process.emit("unhandledRejection", "plain reason", Promise.resolve());

    expect(logger.error).toHaveBeenCalledWith("unhandledRejection: plain reason");
    expect(target.stop).toHaveBeenCalledWith(1, "crashed: plain reason");
  });

  it("exits at once on a second crash", () => {
    const target = stoppable(() => new Promise(() => {}));
    const { exit } = install(target);

    process.emit("uncaughtException", new Error("first"), "uncaughtException");
    process.emit("uncaughtException", new Error("second"), "uncaughtException");

    expect(target.stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits when stopping doesn't finish within the watchdog time", () => {
    vi.useFakeTimers();
    const target = stoppable(() => new Promise(() => {}));
    const { exit } = install(target, 5_000);

    process.emit("uncaughtException", new Error("hang"), "uncaughtException");
    vi.advanceTimersByTime(4_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("logs and exits when stopping fails after a crash", async () => {
    const target = stoppable(async () => {
      throw new Error("release failed");
    });
    const { logger, exit } = install(target);

    process.emit("uncaughtException", new Error("boom"), "uncaughtException");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("stop failed after a crash: Error: release failed"));
  });

  it("stops listening once uninstalled", () => {
    const before = [process.listenerCount("uncaughtException"), process.listenerCount("unhandledRejection")];
    install(stoppable());
    expect(process.listenerCount("uncaughtException")).toBe(before[0] + 1);
    uninstall!();
    uninstall = undefined;

    expect([process.listenerCount("uncaughtException"), process.listenerCount("unhandledRejection")]).toEqual(before);
  });
});

describe("installSignalHandlers", () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it.each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("stops the daemon with exit code 0 on %s, naming the signal", (signal) => {
    const target = stoppable();
    uninstall = installSignalHandlers(target);

    process.emit(signal, signal);

    expect(target.stop).toHaveBeenCalledWith(0, `signal ${signal}`);
  });

  it("handles only the first signal, leaving later ones to their default action", () => {
    const before = process.listenerCount("SIGTERM");
    const target = stoppable();
    uninstall = installSignalHandlers(target);

    process.emit("SIGTERM", "SIGTERM");

    expect(target.stop).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("daemonStopBudgetMs", () => {
  it("allows two kill-grace windows plus the shutdown margin", () => {
    expect(daemonStopBudgetMs(500)).toBe(1_000 + DAEMON_SHUTDOWN_MARGIN_MS);
  });

  it("never exceeds the longest timer Node can schedule", () => {
    expect(daemonStopBudgetMs(Number.MAX_SAFE_INTEGER)).toBe(2_147_483_647);
  });
});
