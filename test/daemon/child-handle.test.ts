import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ChildHandle } from "../../src/daemon/child-handle.js";
import { STDERR_DRAIN_MS } from "../../src/daemon/stderr-capture.js";
import type { ProcessExit } from "../../src/daemon/child-handle.js";
import { processExists } from "../../src/process/process-utils.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";

const CLOSES_STDIN = `require("node:fs").closeSync(0); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "ready" }) + "\\n"); setInterval(() => {}, 1_000)`;
const IGNORES_SIGTERM = "process.on('SIGTERM', () => {}); process.stdout.write('{\"ready\":true}\\n'); setInterval(() => {}, 1e6)";
const FLOODS_STDOUT = "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1e6)";
const CLOSES_STDOUT = "require('node:fs').closeSync(1); setInterval(() => {}, 1e6)";
const WRITES_STDERR_THEN_EXITS = "process.stderr.write('noise\\n'.repeat(20000) + 'Error: missing API token\\n', () => process.exit(3))";
const KILLS_ITSELF = "process.stderr.write('about to crash\\n', () => process.kill(process.pid, 'SIGKILL'))";
const WRITES_STDERR_WITHOUT_NEWLINE_THEN_EXITS = "process.stderr.write('fatal: no newline', () => process.exit(1))";
const spawnWithParentPidSharingStderr = (script: string, stdio: string) =>
  `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(script)}, String(process.pid)], { stdio: ${stdio}, detached: true })`;
const spawnSharingStderr = (script: string) => spawnWithParentPidSharingStderr(script, "['ignore', 'ignore', 'inherit']");
const spawnSharingStderrThenOnceReady = (script: string, then: string) =>
  `const sharer = ${spawnWithParentPidSharingStderr(`${script}; require('node:fs').writeSync(3, 'ready')`, "['ignore', 'ignore', 'inherit', 'pipe']")}; sharer.stdio[3].once('data', () => { ${then} })`;
const LATE_LINE_DELAY_MS = 100;
const WRITES_ONCE_PARENT_IS_GONE = `const parent = Number(process.argv[1]); setTimeout(() => process.exit(0), 10_000).unref(); const poll = setInterval(() => { try { process.kill(parent, 0); } catch { clearInterval(poll); setTimeout(() => process.stderr.write('Error: late line\\n'), ${LATE_LINE_DELAY_MS}); } }, 5)`;
const EXITS_BEFORE_A_SHARER_WRITES_STDERR = spawnSharingStderrThenOnceReady(WRITES_ONCE_PARENT_IS_GONE, "process.exit(2)");
const LEAVES_GRANDCHILD_ON_STDERR = `const g = ${spawnSharingStderr("setTimeout(() => {}, 30_000)")}; process.stderr.write('grandchild ' + g.pid + '\\n', () => process.exit(0))`;
const WRITES_A_LINE_THEN_EXITS = "process.stderr.write('bye\\n', () => process.exit(3))";
const PRINTS_MORE_ON_REQUEST = "process.stdout.write('first\\n' + 'noise\\n'.repeat(50) + '{\"ready\":true}\\n'); process.stdin.on('data', () => process.stdout.write('last\\n{\"ready\":true}\\n')); setInterval(() => {}, 1e6)";
const PRINTS_NOISE_THEN_EXITS = "process.stdout.write('first\\n' + 'noise\\n'.repeat(5)); setTimeout(() => process.exit(3), 100)";
const PRINTS_NOISE_THEN_WAITS = "process.stdout.write('first\\n' + 'noise\\n'.repeat(5) + '{\"ready\":true}\\n'); setInterval(() => {}, 1e6)";
const PRINTS_SECRETS_ON_STDOUT = "process.stdout.write('ghp_SECRETTOKEN1\\n' + 'Using API key sk-live-SECRET\\n'.repeat(50) + '{\"ready\":true}\\n'); setInterval(() => {}, 1e6)";

describe.skipIf(process.platform === "win32")("ChildHandle", { timeout: 15_000 }, () => {
  const handles: ChildHandle[] = [];
  const grandchildren: number[] = [];

  const trackGrandchild = (stderr: string[]) => grandchildren.push(Number(stderr[0]!.split(" ")[1]));

  afterEach(async () => {
    for (const pid of grandchildren.splice(0)) process.kill(pid, "SIGKILL");
    await Promise.all(handles.splice(0).map((h) => h.kill(0)));
  });

  function spawnChild(script: string, stdoutMaxBytes?: number) {
    const events = { closes: 0, messages: 0, exits: [] as ProcessExit[], stderr: [] as string[], stderrAtClose: [] as string[], errors: [] as string[], errorsAtClose: [] as string[] };
    const handle = new ChildHandle({
      command: process.execPath,
      args: ["-e", script],
      env: process.env as Record<string, string>,
      ...(stdoutMaxBytes !== undefined && { stdoutMaxBytes }),
      onMessage: () => events.messages++,
      onClose: (exit) => {
        events.closes++;
        events.exits.push(exit);
        events.stderrAtClose = [...events.stderr];
        events.errorsAtClose = [...events.errors];
      },
      onError: (err) => events.errors.push(err.message),
      onStderr: (line) => events.stderr.push(line),
    });
    handles.push(handle);
    return { handle, events };
  }

  it("reports a write to a child that closed its stdin as an error instead of crashing, and still stops it", async () => {
    const { handle, events } = spawnChild(CLOSES_STDIN);
    await until(() => events.messages > 0);

    await until(() => {
      try {
        handle.send({ jsonrpc: "2.0", method: "notifications/ping" });
      } catch {
        /* stdin already closed */
      }
      return events.errors.some((error) => error.includes("EPIPE"));
    });

    await handle.kill(1_000);
    expect(processExists(handle.pid!)).toBe(false);
  });

  it("returns the kill already in progress to a second caller and SIGKILLs a SIGTERM-ignoring child", async () => {
    const { handle, events } = spawnChild(IGNORES_SIGTERM);
    await until(() => events.messages > 0);

    const first = handle.kill(300);
    const second = handle.kill(300);

    expect(second).toBe(first);
    await first;
    expect(processExists(handle.pid!)).toBe(false);
    expect(handle.lastSignalSent).toBe("SIGKILL");
    await until(() => handle.exitStatus !== null);
    expect(handle.exitStatus).toEqual({ code: null, signal: "SIGKILL" });
  });

  it("reports output that isn't JSON by its size only, and at most once a second", async () => {
    const { events } = spawnChild(PRINTS_SECRETS_ON_STDOUT);

    await until(() => events.messages > 0);

    expect(events.errors).toEqual(["child stdout produced a line that isn't JSON (16 bytes)"]);
  });

  it("reports the lines it held back once a second has passed", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const { handle, events } = spawnChild(PRINTS_MORE_ON_REQUEST);
      await until(() => events.messages > 0);

      vi.advanceTimersByTime(1_000);
      handle.send({ jsonrpc: "2.0", method: "more" });
      await until(() => events.messages > 1);

      expect(events.errors).toEqual([
        "child stdout produced a line that isn't JSON (5 bytes)",
        "child stdout produced 51 lines that aren't JSON since the last report (latest 4 bytes)",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports held-back non-JSON lines before reporting the child's exit", async () => {
    const { events } = spawnChild(PRINTS_NOISE_THEN_EXITS);
    await until(() => events.closes > 0);
    expect(events.errorsAtClose).toEqual([
      "child stdout produced a line that isn't JSON (5 bytes)",
      "child stdout produced 5 lines that aren't JSON since the last report (latest 5 bytes)",
    ]);
  });

  it("reports held-back non-JSON lines when killed", async () => {
    const { handle, events } = spawnChild(PRINTS_NOISE_THEN_WAITS);
    await until(() => events.messages > 0);
    await handle.kill(300);
    expect(events.errors).toEqual([
      "child stdout produced a line that isn't JSON (5 bytes)",
      "child stdout produced 5 lines that aren't JSON since the last report (latest 5 bytes)",
    ]);
  });

  it("reports a child it killed for flooding stdout through onClose, once", async () => {
    const { events } = spawnChild(FLOODS_STDOUT, 1_024);

    await until(() => events.closes > 0);
    await new Promise((r) => setTimeout(r, 200));

    expect(events.closes).toBe(1);
    expect(events.exits).toEqual([{ cause: "output_flood", code: null, signal: null }]);
  });

  it("reports the exit code and keeps the last stderr line after a burst of output", async () => {
    const { handle, events } = spawnChild(WRITES_STDERR_THEN_EXITS);

    await until(() => events.closes > 0);

    expect(events.exits).toEqual([{ cause: "exited", code: 3, signal: null }]);
    expect(handle.stderrTail().at(-1)).toBe("Error: missing API token");
    expect(events.stderrAtClose.at(-1)).toBe("Error: missing API token");
  });

  it("reports an ordinary exit as soon as stderr has closed, without waiting out the drain", async () => {
    const { handle, events } = spawnChild(WRITES_A_LINE_THEN_EXITS);
    await until(() => handle.exitStatus !== null);
    const exitedAt = Date.now();

    await until(() => events.closes > 0);

    expect(Date.now() - exitedAt).toBeLessThan(STDERR_DRAIN_MS / 2);
    expect(events.exits).toEqual([{ cause: "exited", code: 3, signal: null }]);
  });

  it("reports the signal that killed the child", async () => {
    const { handle, events } = spawnChild(KILLS_ITSELF);

    await until(() => events.closes > 0);

    expect(events.exits).toEqual([{ cause: "exited", code: null, signal: "SIGKILL" }]);
    expect(handle.stderrTail()).toEqual(["about to crash"]);
  });

  it("does not wait past the drain time for a grandchild that keeps the child's stderr open", async () => {
    const { events } = spawnChild(LEAVES_GRANDCHILD_ON_STDERR);
    await until(() => events.stderr.length > 0);
    trackGrandchild(events.stderr);
    const startedAt = Date.now();

    await until(() => events.closes > 0);

    expect(Date.now() - startedAt).toBeLessThan(STDERR_DRAIN_MS + 1_000);
    expect(events.exits).toEqual([{ cause: "exited", code: 0, signal: null }]);
  });

  it("reports a command that can't be started at once, with the reason as its last stderr line", async () => {
    const events = { exits: [] as ProcessExit[], stderr: [] as string[], errors: [] as string[] };
    const handle = new ChildHandle({
      command: "/nonexistent/cbe-no-such-server",
      args: [],
      env: process.env as Record<string, string>,
      onMessage: () => {},
      onClose: (exit) => events.exits.push(exit),
      onError: (err) => events.errors.push(err.message),
      onStderr: (line) => events.stderr.push(line),
    });
    handles.push(handle);
    const startedAt = Date.now();

    await until(() => events.exits.length > 0);

    expect(Date.now() - startedAt).toBeLessThan(STDERR_DRAIN_MS);
    expect(events.exits).toEqual([{ cause: "failed_to_start", code: null, signal: null }]);
    expect(handle.stderrTail()).toEqual(["spawn /nonexistent/cbe-no-such-server ENOENT"]);
    expect(events.stderr).toEqual(["spawn /nonexistent/cbe-no-such-server ENOENT"]);
    expect(events.errors).toEqual(["spawn /nonexistent/cbe-no-such-server ENOENT"]);
  });

  it("waits for stderr that a process sharing it writes after the child has exited", async () => {
    const { handle, events } = spawnChild(EXITS_BEFORE_A_SHARER_WRITES_STDERR);

    await until(() => events.closes > 0);

    expect(events.exits).toEqual([{ cause: "exited", code: 2, signal: null }]);
    expect(events.stderrAtClose).toEqual(["Error: late line"]);
    expect(handle.stderrTail()).toEqual(["Error: late line"]);
  });

  it("keeps a last stderr line written without a newline", async () => {
    const { handle, events } = spawnChild(WRITES_STDERR_WITHOUT_NEWLINE_THEN_EXITS);

    await until(() => events.closes > 0);

    expect(events.stderrAtClose).toEqual(["fatal: no newline"]);
    expect(handle.stderrTail()).toEqual(["fatal: no newline"]);
  });

  it("does not report a child that is killed while its stderr is still draining", async () => {
    const { handle, events } = spawnChild(LEAVES_GRANDCHILD_ON_STDERR);
    await until(() => events.stderr.length > 0);
    trackGrandchild(events.stderr);
    await until(() => handle.exitStatus !== null);

    void handle.kill(0);
    await new Promise((r) => setTimeout(r, STDERR_DRAIN_MS + 200));

    expect(events.closes).toBe(0);
  });

  it("does not report a child it was asked to kill", async () => {
    const { handle, events } = spawnChild(IGNORES_SIGTERM);
    await until(() => events.messages > 0);

    await handle.kill(0);
    await new Promise((r) => setTimeout(r, STDERR_DRAIN_MS + 200));

    expect(events.closes).toBe(0);
  });

  it("still signals a child whose stdout closed while it kept running", async () => {
    const { handle, events } = spawnChild(CLOSES_STDOUT);
    await until(() => events.closes > 0);
    expect(processExists(handle.pid!)).toBe(true);

    await handle.kill(300);

    expect(processExists(handle.pid!)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("ChildHandle for a command that can't start", () => {
  it("sends no signal when killed before Node reports the failed start, which would reach its whole process group", { timeout: 30_000 }, async () => {
    const entry = await bundleForSubprocess("test/_helpers/subprocess/failed-spawn-kill.ts", "failed-spawn-kill");
    const probe = spawn(process.execPath, [entry], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    probe.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));

    const [code, signal] = (await once(probe, "exit")) as [number | null, NodeJS.Signals | null];

    expect({ code, signal, stdout }).toEqual({ code: 0, signal: null, stdout: "survived\n" });
  });

  it("refuses to spawn with a value Node rejects, naming only the error code", () => {
    const start = () =>
      new ChildHandle({ command: process.execPath, args: [], env: { X: "secret-value\u0000" }, onMessage: () => {}, onClose: () => {}, onError: () => {}, onStderr: () => {} });

    expect(start).toThrow(`spawn failed for ${process.execPath}: ERR_INVALID_ARG_VALUE`);
    expect(start).not.toThrow(/secret-value/);
  });
});
