import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogFile } from "../../src/logging/log-file.js";

const isWindows = process.platform === "win32";

describe("LogFile", () => {
  let root: string;
  let path: string;
  const opened: LogFile[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cbe-log-file-"));
    path = join(root, "logs", "daemon.log");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const file of opened.splice(0)) file.close();
    if (!isWindows) chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function logFile(maxBytes = 1_000_000, recheckMs = 0): LogFile {
    const file = new LogFile({ path, maxBytes, recheckMs });
    opened.push(file);
    return file;
  }

  const read = (at = path) => readFileSync(at, "utf8");
  const makeLogDir = () => mkdirSync(join(root, "logs"), { mode: 0o700 });
  const blockRotation = () => {
    makeLogDir();
    mkdirSync(`${path}.1`);
    writeFileSync(join(`${path}.1`, "blocker"), "");
  };

  it("creates the directory and file and appends each line", () => {
    const file = logFile();
    file.write("one\n");
    file.write("two\n");
    expect(read()).toBe("one\ntwo\n");
  });

  it.skipIf(isWindows)("makes an existing directory and file private to the user", () => {
    mkdirSync(join(root, "logs"), { mode: 0o755 });
    chmodSync(join(root, "logs"), 0o755);
    writeFileSync(path, "", { mode: 0o644 });
    chmodSync(path, 0o644);

    logFile().write("line\n");

    expect(statSync(join(root, "logs")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("rotates to .1 once the next line would pass the limit, replacing an older .1", () => {
    makeLogDir();
    writeFileSync(`${path}.1`, "older rotation\n");
    const file = logFile(20);
    file.write("0123456789\n");
    file.write("abcdefghij\n");
    expect(read(`${path}.1`)).toBe("0123456789\n");
    expect(read()).toBe("abcdefghij\n");
  });

  it("keeps lines that fill the file exactly to the limit in one file", () => {
    const file = logFile(22);
    file.write("0123456789\n");
    file.write("abcdefghij\n");
    expect(read()).toBe("0123456789\nabcdefghij\n");
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it("rotates a file that is already over the limit before its first line", () => {
    makeLogDir();
    writeFileSync(path, "x".repeat(30));
    logFile(20).write("first\n");
    expect(read(`${path}.1`)).toBe("x".repeat(30));
    expect(read()).toBe("first\n");
  });

  it("writes a single line longer than the limit instead of dropping it", () => {
    const file = logFile(4);
    file.write("longer than four\n");
    expect(read()).toBe("longer than four\n");
    expect(existsSync(`${path}.1`)).toBe(false);
  });

  it("empties the file instead of growing it when it can't be moved aside", () => {
    blockRotation();
    const file = logFile(100);
    for (let i = 0; i < 50; i++) file.write(`line ${String(i).padStart(4, "0")}\n`);
    expect(statSync(path).size).toBeLessThanOrEqual(100);
    expect(read().endsWith("line 0049\n")).toBe(true);
  });

  it("recreates the file when it is deleted while open", () => {
    const file = logFile();
    file.write("before\n");
    unlinkSync(path);
    file.write("after\n");
    expect(read()).toBe("after\n");
  });

  it("follows a rename made by someone else instead of writing into the old file", () => {
    const file = logFile();
    file.write("mine\n");
    renameSync(path, `${path}.1`);
    file.write("next\n");
    expect(read(`${path}.1`)).toBe("mine\n");
    expect(read()).toBe("next\n");
  });

  it("moves onto the new file after another writer rotates it", () => {
    const a = logFile();
    const b = logFile(20);
    a.write("a1\n");
    b.write("b1-xxxxxxx\n");
    b.write("b2-xxxxxxx\n");
    a.write("a2\n");
    expect(read(`${path}.1`)).toBe("a1\nb1-xxxxxxx\n");
    expect(read()).toBe("b2-xxxxxxx\na2\n");
  });

  it("checks for a rename or deletion at most once per recheck interval", () => {
    const file = logFile(1_000_000, 60_000);
    file.write("first\n");
    renameSync(path, `${path}.1`);
    file.write("second\n");
    expect(read(`${path}.1`)).toBe("first\nsecond\n");
    expect(existsSync(path)).toBe(false);
  });

  it("counts another writer's lines toward the limit", () => {
    const a = logFile(20);
    const b = logFile();
    a.write("a1\n");
    b.write("b-xxxxxxxxxxxx\n");
    a.write("a2-xxxxx\n");
    expect(read(`${path}.1`)).toBe("a1\nb-xxxxxxxxxxxx\n");
    expect(read()).toBe("a2-xxxxx\n");
  });

  it("doesn't move aside a file another writer has just rotated in", () => {
    const a = logFile(20, 60_000);
    const b = logFile(20);
    a.write("a1-xxxxxxx\n");
    b.write("b1-xxxxxxx\n");
    a.write("a2-xxxxxxx\n");
    expect(read(`${path}.1`)).toBe("a1-xxxxxxx\n");
    expect(read()).toBe("b1-xxxxxxx\na2-xxxxxxx\n");
  });

  it("doesn't empty a file another writer has already emptied", () => {
    blockRotation();
    const a = logFile(20, 60_000);
    const b = logFile(20, 60_000);
    a.write("a1-xxxxxxxxxxxxx\n");
    b.write("b1-xxxxx\n");
    a.write("a2-xxxx\n");
    expect(read()).toBe("b1-xxxxx\na2-xxxx\n");
  });

  it("keeps every line whole when two writers share the file", () => {
    const a = logFile();
    const b = logFile();
    for (let i = 0; i < 200; i++) {
      a.write(`a ${i} ${"x".repeat(100)}\n`);
      b.write(`b ${i} ${"y".repeat(100)}\n`);
    }
    const lines = read().trimEnd().split("\n");
    expect(lines).toHaveLength(400);
    for (const line of lines) expect(line).toMatch(/^(a \d+ x{100}|b \d+ y{100})$/);
  });

  it.skipIf(isWindows)("refuses a symlinked log directory", () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "logs"));
    logFile().write("line\n");
    expect(existsSync(join(elsewhere, "daemon.log"))).toBe(false);
  });

  it.skipIf(isWindows)("refuses a symlinked log file", () => {
    makeLogDir();
    const target = join(root, "target");
    writeFileSync(target, "");
    symlinkSync(target, path);
    logFile().write("line\n");
    expect(read(target)).toBe("");
  });

  it.skipIf(isWindows)("refuses a log file with another hard link", () => {
    makeLogDir();
    const target = join(root, "target");
    writeFileSync(target, "");
    linkSync(target, path);
    logFile().write("line\n");
    expect(read(target)).toBe("");
  });

  it.skipIf(isWindows)("refuses a log file owned by someone else", () => {
    makeLogDir();
    writeFileSync(path, "");
    vi.spyOn(process, "geteuid").mockReturnValue(process.geteuid!() + 1);
    logFile().write("line\n");
    expect(read()).toBe("");
  });

  it.skipIf(isWindows)("waits a recheck interval before retrying after it couldn't open the file", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    chmodSync(root, 0o500);
    const file = logFile(1_000_000, 60_000);
    file.write("lost\n");
    chmodSync(root, 0o700);
    file.write("still lost\n");
    expect(existsSync(path)).toBe(false);

    vi.advanceTimersByTime(60_000);
    file.write("kept\n");
    expect(read()).toBe("kept\n");
  });

  it.skipIf(isWindows)("does nothing, without throwing, when the directory can't be created, and recovers once it can", () => {
    chmodSync(root, 0o500);
    const file = logFile();
    expect(() => file.write("lost\n")).not.toThrow();
    expect(existsSync(path)).toBe(false);

    chmodSync(root, 0o700);
    file.write("kept\n");
    expect(read()).toBe("kept\n");
  });
});
