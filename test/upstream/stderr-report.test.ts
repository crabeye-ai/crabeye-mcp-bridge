import { describe, expect, it } from "vitest";
import {
  NO_STDERR_OUTPUT,
  ChildStopWarnings,
  childStopWarning,
  stderrLineFor,
  type ChildStopWarning,
} from "../../src/upstream/stderr-report.js";
import { spyLogger } from "../_helpers/spy-logger.js";
import { STDERR_LINE_MAX_CHARS, STDERR_LINE_MAX_SENT_CHARS, STDERR_TAIL_LINES, capStderrLine } from "../../src/daemon/protocol.js";

describe("stderrLineFor", () => {
  it.each([
    [{ sessionId: "s1", line: "listening on 3000" }, "listening on 3000"],
    [{ sessionId: "s2", line: "not ours" }, null],
    [{ sessionId: "s1", line: "" }, null],
    [{ sessionId: "s1", line: 42 }, null],
    [{ sessionId: "s1" }, null],
    [null, null],
    ["s1", null],
  ])("reads %j for session s1 as %j", (params, expected) => {
    expect(stderrLineFor(params, "s1")).toBe(expected);
  });

  it("caps a line longer than the daemon would send", () => {
    expect(stderrLineFor({ sessionId: "s1", line: "z".repeat(STDERR_LINE_MAX_SENT_CHARS + 50) }, "s1")).toBe(
      `${"z".repeat(STDERR_LINE_MAX_SENT_CHARS)} [truncated]`,
    );
  });

  it.each([
    ["z".repeat(STDERR_LINE_MAX_CHARS + 1)],
    [`${"z".repeat(STDERR_LINE_MAX_CHARS - 1)}${String.fromCodePoint(0x1f600)}`],
  ])("leaves a line the daemon already cut as it is", (raw) => {
    const sent = capStderrLine(raw, STDERR_LINE_MAX_CHARS);

    expect(stderrLineFor({ sessionId: "s1", line: sent }, "s1")).toBe(sent);
  });
});

describe("childStopWarning", () => {
  it.each([
    [{ cause: "exited", code: 1, signal: null }, "STDIO server exited with code 1"],
    [{ cause: "exited", code: 0, signal: null }, "STDIO server exited with code 0"],
    [{ cause: "exited", code: null, signal: "SIGSEGV" }, "STDIO server was killed by signal SIGSEGV"],
    [{ cause: "exited", code: null, signal: null }, "STDIO server exited"],
    [{ cause: "failed_to_start", code: null, signal: null }, "STDIO server could not be started"],
    [{ cause: "unresponsive", code: null, signal: null }, "STDIO server stopped answering and was stopped"],
    [{ cause: "output_flood", code: null, signal: null }, "STDIO server sent a message too large to read and was stopped"],
  ])("describes %j as %j", (exit, message) => {
    expect(childStopWarning({ exit, stderr: ["last line"] })).toEqual({ message, stderr: ["last line"] });
  });

  it.each([
    [{ cause: "exited", code: "1", signal: "SIG\u001b[2J" }],
    [{ cause: "exited", code: 1.5, signal: "sigterm" }],
  ])("ignores an unusable code or signal: %j", (exit) => {
    expect(childStopWarning({ exit, stderr: ["last line"] })).toEqual({ message: "STDIO server exited", stderr: ["last line"] });
  });

  it.each([[{ cause: "out_of_memory", code: 1, signal: null }], [{}]])(
    "still warns, with the lines, for a stop it doesn't recognise: %j",
    (exit) => {
      expect(childStopWarning({ exit, stderr: ["killed: memory limit"] })).toEqual({
        message: "STDIO server stopped",
        stderr: ["killed: memory limit"],
      });
    },
  );

  it.each([[{}], [{ exit: null }], [{ exit: "exited" }]])(
    "gives no warning for an eviction without usable exit details: %j",
    (evicted) => {
      expect(childStopWarning(evicted)).toBeNull();
    },
  );

  it.each([[[]], [undefined], ["Error: boom"], [[42, ""]]])("says there was no stderr output when the lines are %j", (stderr) => {
    expect(childStopWarning({ exit: { cause: "exited", code: 1, signal: null }, stderr })).toEqual({
      message: "STDIO server exited with code 1",
      stderr: [NO_STDERR_OUTPUT],
    });
  });

  it("keeps only string lines, at most the last lines the daemon keeps, each capped", () => {
    const stderr = [7, ...Array.from({ length: STDERR_TAIL_LINES + 3 }, (_, i) => `line ${i}`), "q".repeat(STDERR_LINE_MAX_SENT_CHARS + 1)];

    const warning = childStopWarning({ exit: { cause: "exited", code: 1, signal: null }, stderr });

    expect(warning!.stderr).toHaveLength(STDERR_TAIL_LINES);
    expect(warning!.stderr[0]).toBe("line 4");
    expect(warning!.stderr.at(-1)).toBe(`${"q".repeat(STDERR_LINE_MAX_SENT_CHARS)} [truncated]`);
  });
});

describe("ChildStopWarnings", () => {
  const crashed: ChildStopWarning = { message: "STDIO server exited with code 1", stderr: ["12:00:01 Error: missing token"] };

  function newWarnings() {
    const logger = spyLogger();
    return { logger, warnings: new ChildStopWarnings(logger) };
  }

  it("warns for the first stop, then logs the same stop at debug even when its lines differ", () => {
    const { logger, warnings } = newWarnings();
    const later = { ...crashed, stderr: ["12:00:31 Error: missing token"] };

    warnings.log(crashed);
    warnings.log(later);

    expect(logger.warn.mock.calls).toEqual([[crashed.message, { stderr: crashed.stderr }]]);
    expect(logger.debug.mock.calls).toEqual([[later.message, { stderr: later.stderr }]]);
  });

  it("warns for a stop with a different message", () => {
    const { logger, warnings } = newWarnings();
    const killed: ChildStopWarning = { message: "STDIO server was killed by signal SIGKILL", stderr: [NO_STDERR_OUTPUT] };

    warnings.log(crashed);
    warnings.log(killed);

    expect(logger.warn.mock.calls).toEqual([
      [crashed.message, { stderr: crashed.stderr }],
      [killed.message, { stderr: killed.stderr }],
    ]);
  });

  it("warns again for the same stop once the server has connected in between, then logs further repeats at debug", () => {
    const { logger, warnings } = newWarnings();
    warnings.log(crashed);

    warnings.connected();
    warnings.log(crashed);
    warnings.log(crashed);

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });
});
