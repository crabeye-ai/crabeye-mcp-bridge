import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AttachedBridge, fixtureSource, servingConfigs, spawnTestManager, stubServerFile, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import { runRestartUpstream } from "../../src/commands/daemon.js";
import { FAST_RECONNECT } from "../_helpers/stdio-manager.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("CLI: daemon restart-upstream", () => {
  let fx: DaemonFixture;
  let stub: Awaited<ReturnType<typeof stubServerFile>>;
  let bridge: AttachedBridge | undefined;

  beforeEach(async () => {
    stub = await stubServerFile();
    const server = (arg: string) => ({ command: process.execPath, args: [stub.path, arg], _bridge: FAST_RECONNECT });
    const missing = { command: "/nonexistent/cbe-missing", _bridge: FAST_RECONNECT };
    fx = await spawnTestManager({ manager: { childPingMs: 0, ...servingConfigs({ [fixtureSource.path]: { alpha: server("--one"), beta: server("--two"), missing } }) } });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    bridge?.close();
    bridge = undefined;
    await fx.stop();
    await stub.cleanup();
  });

  async function childPids(): Promise<number[]> {
    return ((await fx.client.call("STATUS")) as { children: { pid: number }[] }).children.map((child) => child.pid);
  }

  async function attached(): Promise<number[]> {
    bridge = await AttachedBridge.attach(fx);
    await bridge.connected("alpha");
    await bridge.connected("beta");
    return childPids();
  }

  it("restarts every STDIO server when --all, including one that isn't running", async () => {
    const before = await attached();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(await runRestartUpstream({ all: true, _socketPath: fx.socketPath })).toBe(0);

    expect(stderr.mock.calls.map(([text]) => String(text))).toContain("restart-upstream: restarted 3 STDIO servers\n");

    await vi.waitFor(async () => {
      const after = await childPids();
      expect(after).toHaveLength(2);
      expect(after.some((pid) => before.includes(pid))).toBe(false);
    });
  });

  it("restarts only the server with the hash it is given", async () => {
    const before = await attached();
    const [first] = ((await fx.client.call("STATUS")) as { children: { pid: number; upstreamHash: string }[] }).children;

    expect(await runRestartUpstream({ hash: first!.upstreamHash, _socketPath: fx.socketPath })).toBe(0);

    await vi.waitFor(async () => {
      const after = await childPids();
      expect(after).toHaveLength(2);
      expect(after).not.toContain(first!.pid);
      expect(after.filter((pid) => before.includes(pid))).toHaveLength(1);
    });
  });

  it("exits 2 when neither --all nor a hash is given", async () => {
    const code = await runRestartUpstream({ _socketPath: fx.socketPath });
    expect(code).toBe(2);
  });

  it("exits 0 when daemon not reachable and --all (no-op)", async () => {
    await fx.stop();
    const code = await runRestartUpstream({ all: true, _socketPath: fx.socketPath });
    expect(code).toBe(0);
  });
});
