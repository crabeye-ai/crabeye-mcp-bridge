import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exited } from "../_helpers/processes.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";

const LINES_PER_WRITER = 2_000;
const isWindows = process.platform === "win32";

describe("LogFile shared by several processes", { timeout: 60_000 }, () => {
  let writer: string;
  let root: string;
  let path: string;

  beforeAll(async () => {
    writer = await bundleForSubprocess("test/_helpers/subprocess/log-writer.ts", "log-writer");
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cbe-log-procs-"));
    path = join(root, "logs", "daemon.log");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function runWriter(tag: string, maxBytes: number): Promise<number | null> {
    const child = spawn(process.execPath, [writer, path, tag, String(LINES_PER_WRITER), String(maxBytes)], { stdio: "ignore" });
    return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  }

  const linesOf = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter((line) => line.length > 0);

  it("keeps every line whole when two processes append at the same time", async () => {
    expect(await Promise.all([runWriter("a", 100_000_000), runWriter("b", 100_000_000)])).toEqual([0, 0]);

    const lines = await linesOf(path);
    expect(lines).toHaveLength(2 * LINES_PER_WRITER);
    for (const line of lines) expect(line).toMatch(/^(a \d+ a{100}|b \d+ b{100})$/);
    for (const tag of ["a", "b"]) {
      expect(lines.filter((line) => line.startsWith(`${tag} `)).map((line) => Number(line.split(" ")[1]))).toEqual(
        Array.from({ length: LINES_PER_WRITER }, (_, i) => i),
      );
    }
  });

  it("keeps every line whole while both processes rotate the file", async () => {
    expect(await Promise.all([runWriter("a", 50_000), runWriter("b", 50_000)])).toEqual([0, 0]);

    const rotated = await linesOf(`${path}.1`);
    const lines = [...rotated, ...(await linesOf(path))];
    expect(rotated.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^(a \d+ a{100}|b \d+ b{100})$/);
  });

  it.skipIf(isWindows)("refuses a FIFO at the log path without blocking", async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", [path]);
    const child = spawn(process.execPath, [writer, path, "a", "1", "1000000"], { stdio: "ignore" });

    const code = await exited(child, 5_000);
    if (code === "running") child.kill("SIGKILL");

    expect(code).toBe(0);
  });
});
