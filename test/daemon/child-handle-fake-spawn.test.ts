import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { ChildHandle, type ProcessExit } from "../../src/daemon/child-handle.js";
import { killProcessTree } from "../../src/process/process-utils.js";
import { until } from "../_helpers/daemon-fixtures.js";

const DRAIN_MS = 50;
const spawned = vi.hoisted(() => ({ child: undefined as FakeChild | undefined }));

vi.mock("../../src/process/process-utils.js", () => ({ killProcessTree: vi.fn(async () => true) }));

vi.mock("../../src/daemon/spawn-server.js", () => ({
  spawnServer: () => {
    spawned.child = new FakeChild();
    return spawned.child;
  },
}));

class FakeChild extends EventEmitter {
  pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

function start() {
  const events = { exits: 0, errors: 0, closes: [] as ProcessExit[] };
  const handle = new ChildHandle({
    command: "server",
    args: [],
    env: {},
    stderrDrainMs: DRAIN_MS,
    onMessage: () => {},
    onError: () => events.errors++,
    onExit: () => events.exits++,
    onClose: (exit) => events.closes.push(exit),
  });
  return { handle, child: spawned.child!, events };
}

function replaceExitWithError(child: FakeChild): void {
  child.exitCode = 1;
  child.emit("error", Object.assign(new Error("spawn no-such-command ENOENT"), { code: "ENOENT" }));
  child.stderr.destroy();
}

describe("ChildHandle when the spawned process reports an error", () => {
  it("reports once that a command can't be started when an error replaces the exit of a process that has a pid", async () => {
    const { child, events } = start();

    replaceExitWithError(child);

    await until(() => events.closes.length > 0, 2_000);
    await sleep(2 * DRAIN_MS);
    expect(events.closes).toEqual([{ cause: "failed_to_start", code: null, signal: null }]);
    expect(events.exits).toBe(1);
  });

  it("keeps reporting an exit as an exit when an error follows it", async () => {
    const { child, events } = start();

    child.exitCode = 1;
    child.emit("exit", 1, null);
    child.emit("error", new Error("late error"));
    child.stderr.destroy();

    await until(() => events.closes.length > 0, 2_000);
    await sleep(2 * DRAIN_MS);
    expect(events.closes).toEqual([{ cause: "exited", code: 1, signal: null }]);
    expect(events.exits).toBe(1);
  });

  it("reports an error of a process that hasn't exited only as an error", async () => {
    const { child, events } = start();

    child.emit("error", new Error("kill failed"));
    await sleep(2 * DRAIN_MS);

    expect(events.errors).toBe(1);
    expect(events.exits).toBe(0);
    expect(events.closes).toEqual([]);
  });

  it("finishes stopping a process as soon as an error replaces its exit, without waiting out the kill grace", async () => {
    vi.mocked(killProcessTree).mockClear();
    const { handle, child } = start();

    const stopping = handle.kill(10_000);
    replaceExitWithError(child);

    expect(await Promise.race([stopping.then(() => "stopped"), sleep(2_000, "still waiting")])).toBe("stopped");
    expect(killProcessTree).toHaveBeenCalledTimes(process.platform === "win32" ? 1 : 0);
  });
});

describe("ChildHandle stopping on Windows", () => {
  it("ends the whole process tree before signalling the process", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const { handle, child } = start();
      const steps: string[] = [];
      vi.mocked(killProcessTree).mockImplementationOnce(async () => {
        await sleep(10);
        steps.push("tree");
        return true;
      });
      child.kill.mockImplementation(() => {
        steps.push("signal");
        child.exitCode = 1;
        child.emit("exit", 1, null);
        return true;
      });

      await handle.kill(10_000);

      expect(killProcessTree).toHaveBeenCalledWith(4242, { gracefulMs: 0, forceMs: 0 });
      expect(steps).toEqual(["tree", "signal"]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
