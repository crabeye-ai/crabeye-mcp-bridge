import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChildHandle } from "../../src/daemon/child-handle.js";
import type { ManagerOptions } from "../../src/daemon/manager.js";
import { ProcessTracker } from "../../src/daemon/process-tracker.js";
import {
  ERROR_CODE_DAEMON_STOPPING,
  INNER_ERROR_CODE_UPSTREAM_RESTARTED,
  type OpenParams,
  type StatusResult,
} from "../../src/daemon/protocol.js";
import type { Telemetry } from "../../src/daemon/telemetry.js";
import { processExists } from "../../src/process/process-utils.js";
import {
  OpenSessionFixture,
  spawnTestManager,
  until,
  type DaemonFixture,
  type SpawnTestManagerOpts,
} from "../_helpers/daemon-fixtures.js";

const UPSTREAM = `
  if (process.argv.includes("ignore-sigterm")) process.on("SIGTERM", () => {});
  if (process.argv.includes("close-stdout")) require("node:fs").closeSync(1);
  let muted = false;
  const reply = (id) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result: {} }) + "\\n");
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return;
    if (msg.method === "slow") return;
    if (msg.method === "die") process.exit(0);
    if (msg.method === "flood") { process.stdout.write("x".repeat(4096)); return; }
    if (msg.method === "mute") { reply(msg.id); muted = true; return; }
    if (!muted) reply(msg.id);
  });
  setInterval(() => {}, 1e6);
`;

class RecordingTracker extends ProcessTracker {
  unregistered: number[] = [];

  constructor(
    filePath: string,
    private readonly delayMs = 0,
  ) {
    super({ filePath });
  }

  override async unregister(pid: number): Promise<void> {
    await new Promise((r) => setTimeout(r, this.delayMs));
    await super.unregister(pid);
    this.unregistered.push(pid);
  }
}

type SpawnChild = NonNullable<ManagerOptions["_spawnChild"]>;
type ChildCallbacks = Parameters<SpawnChild>[1];

function realChild(spec: OpenParams["spec"], callbacks: ChildCallbacks, stdoutMaxBytes?: number): ChildHandle {
  return new ChildHandle({
    command: spec.command,
    args: spec.args,
    env: process.env as Record<string, string>,
    ...(stdoutMaxBytes !== undefined && { stdoutMaxBytes }),
    ...callbacks,
  });
}

const isWindows = process.platform === "win32";
const isResponseTo = (id: number) => (p: unknown) => (p as { id?: unknown }).id === id;

describe.skipIf(isWindows)("ManagerDaemon child teardown", { timeout: 30_000 }, () => {
  let fx: DaemonFixture | undefined;
  let trackerDir: string | undefined;
  let nextRequestId = 1_000;

  afterEach(async () => {
    await fx?.stop();
    fx = undefined;
    if (trackerDir) await rm(trackerDir, { recursive: true, force: true });
    trackerDir = undefined;
  });

  async function start(manager: SpawnTestManagerOpts["manager"] = {}): Promise<DaemonFixture> {
    fx = await spawnTestManager({ manager: { childPingMs: 0, ...manager } });
    return fx;
  }

  async function roundTrip(session: OpenSessionFixture): Promise<void> {
    const id = nextRequestId++;
    session.sendRpc({ jsonrpc: "2.0", id, method: "hello" });
    await session.waitForFrame(isResponseTo(id), 5_000);
  }

  async function open(f: DaemonFixture, args: string[] = []): Promise<OpenSessionFixture> {
    const session = await OpenSessionFixture.open(f, { command: process.execPath, args: ["-e", UPSTREAM, ...args] });
    if (!args.includes("close-stdout")) await roundTrip(session);
    return session;
  }

  async function status(f: DaemonFixture): Promise<StatusResult> {
    return (await f.client.call("STATUS")) as StatusResult;
  }

  async function childPid(f: DaemonFixture): Promise<number> {
    const s = await status(f);
    return s.children[0]!.pid;
  }

  async function recordingTracker(delayMs?: number): Promise<RecordingTracker> {
    trackerDir = await mkdtemp("/tmp/cbe-trk-");
    return new RecordingTracker(join(trackerDir, "processes.json"), delayMs);
  }

  function killedTotalAfterStop(f: DaemonFixture): Record<string, number> {
    const telemetry = (f.manager as unknown as { telemetry: Telemetry }).telemetry;
    return telemetry.snapshot().children.killedTotal;
  }

  it("RESTART fails each in-flight request exactly once with upstream_restarted, then evicts the session", async () => {
    const f = await start();
    const session = await open(f);
    session.sendRpc({ jsonrpc: "2.0", id: 7, method: "slow" });
    await roundTrip(session);
    const hash = (await status(f)).children[0]!.upstreamHash;

    const oldPid = await childPid(f);
    await f.client.call("RESTART", { upstreamHash: hash });
    await until(() => session.evictions.length > 0 && session.framesMatching(isResponseTo(7)).length > 0);
    const reopened = await OpenSessionFixture.open(f, { command: process.execPath, args: session.spec.args });
    await roundTrip(reopened);
    const after = await status(f);
    await f.manager.stop(0);

    expect(after.children).toHaveLength(1);
    expect(after.children[0]!.pid).not.toBe(oldPid);
    expect(after.sessions.map((s) => s.sessionId)).not.toContain(session.sessionId);
    expect(after.telemetry.children.killedTotal.restart).toBe(1);
    expect(session.evictions.map((e) => e.reason)).toEqual(["upstream_restarted"]);
    const replies = session.framesMatching(isResponseTo(7));
    expect(replies).toHaveLength(1);
    expect((replies[0] as { error?: { code?: number } }).error?.code).toBe(INNER_ERROR_CODE_UPSTREAM_RESTARTED);
    const replyIndex = session.framesMatching(() => true).indexOf(replies[0]);
    expect(session.evictions[0]!.framesBefore).toBeGreaterThan(replyIndex);
  });

  it("evicts sessions and tears the group down once as a crash, not a grace kill, when the child exits on its own", async () => {
    const tracker = await recordingTracker();
    const f = await start({ graceMs: 0, processTracker: tracker });
    const session = await open(f);
    const pid = await childPid(f);

    session.sendRpc({ jsonrpc: "2.0", id: 1, method: "die" });
    await until(() => session.evictions.length > 0);
    const after = await status(f);
    await f.manager.stop(0);

    expect(session.evictions.map((e) => e.reason)).toEqual(["child_exited"]);
    expect(after.children).toEqual([]);
    expect(after.telemetry.children.killedTotal.crash).toBe(1);
    expect(after.telemetry.children.killedTotal.grace).toBe(0);
    expect(tracker.unregistered.filter((p) => p === pid)).toHaveLength(1);
  });

  it("detects a wedged child that never sent an initialize response, and records it as wedged even with no grace", async () => {
    const f = await start({ graceMs: 0, childPingMs: 100, childPingTimeoutMs: 100, childPingMaxConsecutiveFailures: 1 });
    const session = await open(f);

    session.sendRpc({ jsonrpc: "2.0", id: 1, method: "mute" });
    await until(() => session.evictions.length > 0);

    const after = await status(f);
    expect(after.telemetry.children.killedTotal.wedged).toBe(1);
    expect(after.telemetry.children.killedTotal.grace).toBe(0);
    expect(after.telemetry.children.killedTotal.crash).toBe(0);
  });

  it("tears down a child that floods stdout without a newline", async () => {
    const f = await start({ _spawnChild: (spec, callbacks) => realChild(spec, callbacks, 1_024) });
    const session = await open(f);

    session.sendRpc({ jsonrpc: "2.0", id: 1, method: "flood" });
    await until(() => session.evictions.length > 0);

    expect(session.evictions.map((e) => e.reason)).toEqual(["child_exited"]);
    const after = await status(f);
    expect(after.children).toEqual([]);
    expect(after.telemetry.children.killedTotal.crash).toBe(1);
  });

  it("kills a child that closes its stdout but keeps running", async () => {
    const tracker = await recordingTracker();
    const f = await start({ processTracker: tracker });
    const session = await open(f, ["close-stdout"]);
    const pid = await childPid(f);

    await until(() => session.evictions.length > 0);
    await until(() => tracker.unregistered.includes(pid));

    expect(processExists(pid)).toBe(false);
  });

  it("stop waits for a slow kill and the tracker write, SIGKILLing a child that ignores SIGTERM", async () => {
    const tracker = await recordingTracker(300);
    const f = await start({ killGraceMs: 300, processTracker: tracker });
    await open(f, ["ignore-sigterm"]);
    const pid = await childPid(f);

    await f.manager.stop(0);

    expect(processExists(pid)).toBe(false);
    expect(tracker.unregistered).toContain(pid);
  });

  it("tears down several children in parallel on stop", async () => {
    let killing = 0;
    let peakKilling = 0;
    const f = await start({
      killGraceMs: 300,
      _spawnChild: (spec, callbacks) => {
        const child = realChild(spec, callbacks);
        const kill = child.kill.bind(child);
        child.kill = async (graceMs) => {
          killing++;
          peakKilling = Math.max(peakKilling, killing);
          await kill(graceMs);
          killing--;
        };
        return child;
      },
    });
    await Promise.all([open(f, ["ignore-sigterm"]), open(f, ["ignore-sigterm"]), open(f, ["ignore-sigterm"])]);

    await f.manager.stop(0);

    expect(peakKilling).toBe(3);
  });

  it("stop waits for a teardown that was already under way", async () => {
    const tracker = await recordingTracker(300);
    const f = await start({ graceMs: 0, killGraceMs: 300, processTracker: tracker });
    const session = await open(f, ["ignore-sigterm"]);
    const pid = await childPid(f);

    await f.client.call("CLOSE", { sessionId: session.sessionId });
    await f.manager.stop(0);

    expect(processExists(pid)).toBe(false);
    expect(tracker.unregistered).toContain(pid);
  });

  it("records no grace kill for children torn down by stop", async () => {
    const f = await start({ graceMs: 0 });
    await open(f);

    await f.manager.stop(0);

    expect(killedTotalAfterStop(f).grace).toBe(0);
  });

  it("refuses OPEN on an open connection while stopping, and spawns nothing", async () => {
    let spawned = 0;
    const f = await start({
      killGraceMs: 500,
      _spawnChild: (spec, callbacks) => {
        spawned++;
        return realChild(spec, callbacks);
      },
    });
    const session = await open(f, ["ignore-sigterm"]);
    const stopping = f.manager.stop(0);

    const refused = await f.client
      .call("OPEN", {
        sessionId: "99999999-1111-1111-1111-111111111111",
        spec: { ...session.spec, serverName: "late" },
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    await stopping;

    expect((refused as { code?: string } | null)?.code).toBe(ERROR_CODE_DAEMON_STOPPING);
    expect(spawned).toBe(1);
  });

  it("tears a group down once when the child closes while a RESTART is killing it", async () => {
    const tracker = await recordingTracker(100);
    let callbacks: ChildCallbacks | undefined;
    const f = await start({
      killGraceMs: 300,
      processTracker: tracker,
      _spawnChild: (spec, cb) => {
        callbacks = cb;
        return realChild(spec, cb);
      },
    });
    await open(f, ["ignore-sigterm"]);
    const s = await status(f);
    const pid = s.children[0]!.pid;

    await f.client.call("RESTART", { upstreamHash: s.children[0]!.upstreamHash });
    callbacks!.onClose();
    await f.manager.stop(0);

    expect(tracker.unregistered.filter((p) => p === pid)).toHaveLength(1);
    expect(killedTotalAfterStop(f).restart).toBe(1);
    expect(killedTotalAfterStop(f).crash).toBe(0);
  });

  it("exits on idle once every bridge has gone and the last child's grace teardown finishes", async () => {
    let exited = false;
    fx = await spawnTestManager({
      idleMs: 100,
      manager: {
        childPingMs: 0,
        graceMs: 50,
        onExit: () => {
          exited = true;
        },
      },
    });
    const session = await open(fx);

    await session.close();
    fx.client.close();

    await until(() => exited);
  });

  it("leaves no temp files behind after stopping with a child that is slow to die", async () => {
    const f = await start({ killGraceMs: 300 });
    await open(f, ["ignore-sigterm"]);
    const dir = f.dir;

    await f.stop();
    fx = undefined;
    await new Promise((r) => setTimeout(r, 700));

    await expect(stat(dir)).rejects.toThrow();
  });
});
