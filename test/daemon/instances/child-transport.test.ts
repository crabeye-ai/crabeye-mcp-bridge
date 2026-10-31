import { describe, expect, it, vi } from "vitest";
import type { ChildHandleOptions } from "../../../src/daemon/child-handle.js";
import { ChildTransport, type ChildEvents, type RunningProcess } from "../../../src/daemon/instances/child-transport.js";

interface FakeChild extends RunningProcess {
  options: ChildHandleOptions;
  sent: unknown[];
  kills: number[];
}

function fakeSpawn(): { spawned: FakeChild[]; spawnChild: (options: ChildHandleOptions) => FakeChild } {
  const spawned: FakeChild[] = [];
  return {
    spawned,
    spawnChild: (options) => {
      const child: FakeChild = {
        options,
        sent: [],
        kills: [],
        pid: 77,
        startedAt: 1,
        exitStatus: null,
        lastSignalSent: null,
        stderrTail: () => ["last line"],
        send: (payload) => void child.sent.push(payload),
        kill: async (graceMs) => void child.kills.push(graceMs ?? -1),
      };
      spawned.push(child);
      return child;
    },
  };
}

const INITIALIZE = { jsonrpc: "2.0" as const, id: 1, method: "initialize" };
const DISCOVER = { jsonrpc: "2.0" as const, id: 1, method: "server/discover" };

function recordingEvents(): ChildEvents & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    started: () => void seen.push("started"),
    exited: async (_child, exit) => void seen.push(`exited ${exit.cause}`),
    stopped: async (_child, reason) => void seen.push(`stopped ${reason}`),
    error: (error) => void seen.push(`error ${error.message}`),
  };
}

function setup(events = recordingEvents()) {
  const { spawned, spawnChild } = fakeSpawn();
  const t = new ChildTransport({ command: "node", args: ["s.js"], env: { A: "1" }, cwd: "/srv", killGraceMs: 300, events, onStderr: () => {}, spawnChild });
  return { t, spawned, events };
}

describe("ChildTransport", () => {
  it("starts the server with its command, arguments, environment and cwd, and sends it messages", async () => {
    const { t, spawned, events } = setup();

    await t.start();
    await t.send({ jsonrpc: "2.0", id: 1, method: "ping" });

    expect(spawned[0]!.options).toMatchObject({ command: "node", args: ["s.js"], env: { A: "1" }, cwd: "/srv" });
    expect(spawned[0]!.sent).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(events.seen).toEqual(["started"]);
  });

  it("hands on JSON-RPC messages and reports anything else as an error", async () => {
    const { t, spawned, events } = setup();
    const received: unknown[] = [];
    t.onmessage = (message) => void received.push(message);
    await t.start();

    spawned[0]!.options.onMessage({ jsonrpc: "2.0", id: 1, result: {} });
    spawned[0]!.options.onMessage({ hello: "world" });

    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect(events.seen).toContain("error STDIO server sent a message that isn't JSON-RPC");
  });

  it("reports a server that quits when asked which protocol versions it speaks as failing to connect, not as a crash", async () => {
    const { t, spawned, events } = setup();
    await t.start();
    await t.send(DISCOVER);

    spawned[0]!.options.onExit!();
    spawned[0]!.options.onClose({ cause: "exited", code: 1, signal: null });
    await t.close();

    expect(events.seen).toEqual(["started", "stopped failed to connect"]);
  });

  it("says the server quit on the protocol version question only when it quit on its own after starting", async () => {
    const quit = setup();
    const failedToStart = setup();
    const flooded = setup();
    const stopped = setup();
    for (const { t } of [quit, failedToStart, flooded, stopped]) {
      await t.start();
      await t.send(DISCOVER);
    }

    quit.spawned[0]!.options.onClose({ cause: "exited", code: 1, signal: null });
    failedToStart.spawned[0]!.options.onClose({ cause: "failed_to_start", code: null, signal: null });
    flooded.spawned[0]!.options.onClose({ cause: "output_flood", code: null, signal: "SIGKILL" });
    await Promise.all([quit.t.close(), failedToStart.t.close(), flooded.t.close(), stopped.t.close()]);

    expect([quit, failedToStart, flooded, stopped].map(({ t }) => [t.probing, t.quitOnProbe])).toEqual([
      [true, true],
      [true, false],
      [true, false],
      [true, false],
    ]);
    expect(failedToStart.events.seen).toContain("exited failed_to_start");
    expect(flooded.events.seen).toContain("exited output_flood");
  });

  it("stops probing once anything other than the protocol version question is sent", async () => {
    const { t } = setup();
    await t.start();

    await t.send(DISCOVER);
    expect(t.probing).toBe(true);
    await t.send(INITIALIZE);

    expect(t.probing).toBe(false);
  });

  it("stops the server for the reason it was given, and says it closed once", async () => {
    const { t, spawned, events } = setup();
    const onclose = vi.fn();
    t.onclose = onclose;
    await t.start();
    t.stopFor("restart");

    await t.close();
    await t.close();

    expect(spawned[0]!.kills).toEqual([300]);
    expect(events.seen).toEqual(["started", "stopped restart"]);
    expect(onclose).toHaveBeenCalledTimes(1);
    await expect(t.send({ jsonrpc: "2.0", id: 2, method: "ping" })).rejects.toThrow("STDIO server is not running");
  });

  it("closes when the server ends on its own, and reports how it ended once it has made sure it is gone", async () => {
    const { t, spawned, events } = setup();
    const onclose = vi.fn();
    t.onclose = onclose;
    await t.start();
    await t.send(INITIALIZE);

    spawned[0]!.options.onClose({ cause: "exited", code: 1, signal: null });
    await vi.waitFor(() => expect(events.seen).toContain("exited exited"));
    await t.close();

    expect(spawned[0]!.kills).toEqual([300]);
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(events.seen).toEqual(["started", "exited exited"]);
  });

  it("reports an exit that fails to be reported as an error, and still closes", async () => {
    const events = recordingEvents();
    events.exited = async () => Promise.reject(new Error("report failed"));
    const { t, spawned } = setup(events);
    await t.start();
    await t.send(INITIALIZE);

    spawned[0]!.options.onClose({ cause: "exited", code: 1, signal: null });
    await t.close();

    expect(events.seen).toEqual(["started", "error report failed"]);
  });

  it("refuses to start twice", async () => {
    const { t } = setup();
    await t.start();

    await expect(t.start()).rejects.toThrow("already started");
  });

  it("closes as soon as the server exits, then reports how it ended, and makes a close wait for that report", async () => {
    const { t, spawned, events } = setup();
    const onclose = vi.fn();
    t.onclose = onclose;
    await t.start();
    await t.send(INITIALIZE);

    spawned[0]!.options.onExit!();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(t.endedBecause).toBe("child process exited");
    let closed = false;
    const closing = t.close().then(() => (closed = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    spawned[0]!.options.onClose({ cause: "exited", code: 3, signal: null });
    await closing;

    expect(events.seen).toEqual(["started", "exited exited"]);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("reports only the stop when the server's exit arrives while it is being stopped", async () => {
    const { t, spawned, events } = setup();
    await t.start();
    spawned[0]!.kill = async () => spawned[0]!.options.onClose({ cause: "exited", code: 0, signal: null });

    await t.close();

    expect(events.seen).toEqual(["started", "stopped failed to connect"]);
  });

  it("gives a second close the first one's promise, finishing once the server is gone", async () => {
    const { t, spawned } = setup();
    await t.start();
    let release!: () => void;
    spawned[0]!.kill = () => new Promise<void>((resolve) => (release = resolve));

    const first = t.close();
    const second = t.close();
    release();

    expect(second).toBe(first);
    await first;
  });
});
