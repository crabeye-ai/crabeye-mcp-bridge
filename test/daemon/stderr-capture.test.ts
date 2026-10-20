import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STDERR_FORWARD_LINES_PER_SECOND, StderrCapture, StderrForwardLimit, withheldLinesNotice } from "../../src/daemon/stderr-capture.js";
import { STDERR_LINE_MAX_CHARS, STDERR_TAIL_LINES, capStderrLine } from "../../src/daemon/protocol.js";

function capture(maxLineChars?: number, tailLines?: number) {
  const lines: string[] = [];
  return { lines, stderr: new StderrCapture((line) => lines.push(line), maxLineChars, tailLines) };
}

describe("StderrCapture", () => {
  it("joins a line written across chunks and splits several lines in one chunk", () => {
    const { lines, stderr } = capture();

    stderr.push("Error: con");
    stderr.push("nection refused\nretrying\nsecond ");
    stderr.push("try\n");

    expect(lines).toEqual(["Error: connection refused", "retrying", "second try"]);
  });

  it("drops carriage returns and trailing spaces, and skips blank lines", () => {
    const { lines, stderr } = capture();

    stderr.push("one\r\n\r\n   \ntwo  \n\n");

    expect(lines).toEqual(["one", "two"]);
  });

  it("emits a partial last line when stderr ends, and nothing more for an empty one", () => {
    const { lines, stderr } = capture();

    stderr.push("done\nfatal: no newline");
    stderr.end();
    stderr.end();

    expect(lines).toEqual(["done", "fatal: no newline"]);
  });

  it("cuts a line once it passes the limit and ignores the rest of it until the next newline", () => {
    const { lines, stderr } = capture(10);

    stderr.push("abcdefgh");
    stderr.push("ijklmnop");
    stderr.push("qrstuv".repeat(1_000));
    stderr.push("xyz\nnext\n");

    expect(lines).toEqual(["abcdefghij [truncated]", "next"]);
  });

  it("marks a line that reaches the limit at the end of one chunk and goes on in the next", () => {
    const { lines, stderr } = capture(5);

    stderr.push("abcde");
    stderr.push("f\n");

    expect(lines).toEqual(["abcde [truncated]"]);
  });

  it("keeps a line exactly at the limit whole", () => {
    const { lines, stderr } = capture(5);

    stderr.push("abcde\n");

    expect(lines).toEqual(["abcde"]);
  });

  it("cuts by default at STDERR_LINE_MAX_CHARS", () => {
    const { lines, stderr } = capture();

    stderr.push("x".repeat(STDERR_LINE_MAX_CHARS * 3));

    expect(lines).toEqual([`${"x".repeat(STDERR_LINE_MAX_CHARS)} [truncated]`]);
  });

  it("keeps only the last lines, oldest first", () => {
    const { stderr } = capture(undefined, 3);

    stderr.push("1\n2\n3\n4\n5\n");

    expect(stderr.tail()).toEqual(["3", "4", "5"]);
  });

  it("keeps STDERR_TAIL_LINES last lines by default", () => {
    const { stderr } = capture();

    stderr.push(Array.from({ length: STDERR_TAIL_LINES + 5 }, (_, i) => `line ${i}\n`).join(""));

    expect(stderr.tail()).toHaveLength(STDERR_TAIL_LINES);
    expect(stderr.tail()[0]).toBe("line 5");
  });

  it("returns a copy of the last lines", () => {
    const { stderr } = capture();
    stderr.push("a\n");

    stderr.tail().push("changed");

    expect(stderr.tail()).toEqual(["a"]);
  });
});

describe("capStderrLine", () => {
  it.each([
    ["short", 10, "short"],
    ["abcdefghijk", 10, "abcdefghij [truncated]"],
    [`abcdefghi${String.fromCodePoint(0x1f600)}`, 10, "abcdefghi [truncated]"],
    [`abcdefgh${String.fromCodePoint(0x1f600)}z`, 10, `abcdefgh${String.fromCodePoint(0x1f600)} [truncated]`],
  ])("caps %j at %d characters as %j", (line, max, expected) => {
    expect(capStderrLine(line, max)).toBe(expected);
  });
});

describe("StderrForwardLimit", () => {
  let forwarded: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    forwarded = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards every line while under the limit", () => {
    const limit = new StderrForwardLimit((line) => forwarded.push(line), 3);

    limit.offer("a");
    limit.offer("b");
    limit.offer("c");
    vi.advanceTimersByTime(5_000);

    expect(forwarded).toEqual(["a", "b", "c"]);
  });

  it("withholds lines over the limit and says how many once the second is up", () => {
    const limit = new StderrForwardLimit((line) => forwarded.push(line), 2);

    for (const line of ["a", "b", "c", "d", "e"]) limit.offer(line);
    expect(forwarded).toEqual(["a", "b"]);

    vi.advanceTimersByTime(1_000);
    limit.offer("f");

    expect(forwarded).toEqual(["a", "b", withheldLinesNotice(3), "f"]);
  });

  it("counts the notice against the next second's limit", () => {
    const limit = new StderrForwardLimit((line) => forwarded.push(line), 2);
    for (const line of ["a", "b", "c"]) limit.offer(line);

    vi.advanceTimersByTime(1_000);
    for (const line of ["d", "e", "f"]) limit.offer(line);

    expect(forwarded).toEqual(["a", "b", withheldLinesNotice(1), "d"]);
  });

  it("forwards STDERR_FORWARD_LINES_PER_SECOND lines per second by default", () => {
    const limit = new StderrForwardLimit((line) => forwarded.push(line));

    for (let i = 0; i < STDERR_FORWARD_LINES_PER_SECOND * 2; i++) limit.offer(`line ${i}`);

    expect(forwarded).toHaveLength(STDERR_FORWARD_LINES_PER_SECOND);
  });

  it("counts each second's withheld lines separately", () => {
    const limit = new StderrForwardLimit((line) => forwarded.push(line), 1);

    limit.offer("a");
    limit.offer("b");
    vi.advanceTimersByTime(1_000);
    limit.offer("c");
    vi.advanceTimersByTime(1_000);

    expect(forwarded).toEqual(["a", withheldLinesNotice(1), withheldLinesNotice(1)]);
  });

  it("sends the notice when the second that withheld lines ends, not a second after the first withheld line", () => {
    const limit = new StderrForwardLimit((line) => forwarded.push(line), 1);

    limit.offer("a");
    vi.advanceTimersByTime(600);
    limit.offer("b");
    vi.advanceTimersByTime(400);

    expect(forwarded).toEqual(["a", withheldLinesNotice(1)]);
  });

  it("forwards nothing once stopped", () => {
    const limit = new StderrForwardLimit((line) => forwarded.push(line), 5);
    limit.offer("a");

    limit.stop();
    limit.offer("b");
    vi.advanceTimersByTime(5_000);

    expect(forwarded).toEqual(["a"]);
  });

  it("sends no notice once stopped", () => {
    const limit = new StderrForwardLimit((line) => forwarded.push(line), 1);
    limit.offer("a");
    limit.offer("b");

    limit.stop();
    vi.advanceTimersByTime(5_000);

    expect(forwarded).toEqual(["a"]);
  });

  it.each([
    [1, "(1 more stderr line not shown)"],
    [7, "(7 more stderr lines not shown)"],
  ])("words the notice for %d withheld lines as %j", (count, notice) => {
    expect(withheldLinesNotice(count)).toBe(notice);
  });
});
