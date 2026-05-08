import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnTestManager, OpenSessionFixture, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import { runRestartUpstream } from "../../src/commands/daemon.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("CLI: daemon restart-upstream", () => {
  let fx: DaemonFixture;
  beforeEach(async () => {
    fx = await spawnTestManager();
  });
  afterEach(async () => {
    await fx.stop();
  });

  it("issues one RESTART per active hash when --all", async () => {
    await OpenSessionFixture.open(fx, {
      sessionId: "11111111-1111-1111-1111-111111111111",
      args: ["-e", "process.stdin.on('data', () => {})"],
      serverName: "alpha",
    });
    await OpenSessionFixture.open(fx, {
      sessionId: "22222222-2222-2222-2222-222222222222",
      args: ["-e", "process.stdin.on('data', () => {})", "--two"],
      serverName: "beta",
    });
    const code = await runRestartUpstream({ all: true, _socketPath: fx.socketPath });
    expect(code).toBe(0);
    // Give the manager a tick to actually unregister the killed groups.
    await new Promise((r) => setTimeout(r, 100));
    const status = (await fx.client.call("STATUS")) as { children: unknown[] };
    expect(status.children).toEqual([]);
  });

  it("issues a single RESTART for a hash", async () => {
    await OpenSessionFixture.open(fx);
    const before = (await fx.client.call("STATUS")) as { children: { upstreamHash: string }[] };
    const hash = before.children[0]!.upstreamHash;
    const code = await runRestartUpstream({ hash, _socketPath: fx.socketPath });
    expect(code).toBe(0);
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
