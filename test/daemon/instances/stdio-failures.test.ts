import { afterEach, describe, expect, it } from "vitest";
import { ChildHandle } from "../../../src/daemon/child-handle.js";
import { processExists } from "../../../src/process/process-utils.js";
import { fixtureSource, until, type AttachedBridge } from "../../_helpers/daemon-fixtures.js";
import { FAST_RECONNECT, StdioManagerHarness } from "../../_helpers/stdio-manager.js";
import { STUB_ERROR_THEN_EXIT_ON_DISCOVER_ENV, STUB_EXIT_ON_DISCOVER_ENV, STUB_EXIT_ON_TOOLS_LIST_ENV, STUB_IGNORE_DISCOVER_ENV, STUB_METHOD_LOG_ENV } from "../../_helpers/stub-stdio-server.js";

const isWindows = process.platform === "win32";
const SECRET = "marker-c41f2e";

describe.skipIf(isWindows)("STDIO upstreams in the manager, when things go wrong", { timeout: 40_000 }, () => {
  const h = new StdioManagerHarness();
  const grandchildren: number[] = [];

  afterEach(async () => {
    for (const pid of grandchildren.splice(0)) if (processExists(pid)) process.kill(pid, "SIGKILL");
    await h.cleanUp();
  });

  const levelsOf = (bridge: AttachedBridge, message: string) => bridge.logs.filter((log) => log.message === message).map((log) => log.level);

  it("reports a crash whose stderr a grandchild keeps open as an exit, and serves the next call from a new process meanwhile", async () => {
    await h.start(h.stubServer(), { _stderrDrainMs: 3_000, childPingMs: 100, childPingTimeoutMs: 1_000, childPingMaxConsecutiveFailures: 1 });
    const bridge = await h.attach();
    await bridge.connected("svc");
    const first = await h.childPid();

    await bridge.callTool("svc", "crash", { lines: ["boom"], code: 1, keepStderrOpen: true }).catch(() => {});
    await until(() => bridge.logs.some((log) => log.message.startsWith("grandchild ")));
    grandchildren.push(Number(bridge.logs.find((log) => log.message.startsWith("grandchild "))!.message.split(" ")[1]));
    await until(async () => (await bridge.calledText("svc", "plain").catch(() => null)) === "called plain");

    expect(await h.childPid()).not.toBe(first);
    await until(() => bridge.logs.some((log) => log.message === "STDIO server exited with code 1"), 10_000);
    expect(bridge.logs.some((log) => log.message === "STDIO server stopped answering and was stopped")).toBe(false);
  });

  it("fails a call running when the server is restarted, saying so, and serves the next one", async () => {
    await h.start(h.stubServer());
    const bridge = await h.attach();
    await bridge.connected("svc");
    const slow = bridge.callTool("svc", "slow", { ms: 10_000 });
    await until(async () => (await h.methods()).includes("tools/call"));

    await h.restartChild();

    await expect(slow).rejects.toThrow("upstream restarted");
    await bridge.connected("svc");
    expect(await bridge.calledText("svc", "plain")).toBe("called plain");
  });

  it("fails a call running when the server stops answering pings, saying so", async () => {
    await h.start(h.stubServer(), { childPingMs: 50, childPingTimeoutMs: 50, childPingMaxConsecutiveFailures: 2 });
    const bridge = await h.attach();
    await bridge.connected("svc");
    await bridge.callTool("svc", "ignore-pings");

    await expect(bridge.callTool("svc", "slow", { ms: 10_000 })).rejects.toThrow("child not answering pings");
  });

  it("reports a server that exits while starting, with its last stderr lines, and keeps trying", async () => {
    await h.start(h.stubServer({}, { [STUB_EXIT_ON_TOOLS_LIST_ENV]: "1" }));
    const bridge = await h.attach();

    await until(() => bridge.logs.some((log) => log.message === "STDIO server exited with code 4"));
    expect(bridge.logs.find((log) => log.message === "STDIO server exited with code 4")!.stderr).toEqual(["Error: cannot list tools"]);
    await until(async () => (await h.methods()).filter((method) => method === "initialize").length >= 2);
    expect(bridge.snapshots.get("svc")?.status).not.toBe("connected");
  });

  it("warns once while a server keeps failing to start the same way", async () => {
    await h.start(() => ({ svc: { command: "/nonexistent/cbe-missing", _bridge: FAST_RECONNECT } }));
    const bridge = await h.attach();

    await until(() => levelsOf(bridge, "STDIO server could not be started").length >= 3, 10_000);
    const levels = levelsOf(bridge, "STDIO server could not be started");
    expect(levels[0]).toBe("warn");
    expect(new Set(levels.slice(1))).toEqual(new Set(["debug"]));
  });

  it("warns about every crash that follows a reconnect", async () => {
    await h.start(h.stubServer());
    const bridge = await h.attach();
    await bridge.connected("svc");

    for (let crash = 1; crash <= 2; crash++) {
      await bridge.callTool("svc", "crash", { lines: [], code: 2 }).catch(() => {});
      await until(() => levelsOf(bridge, "STDIO server exited with code 2").length === crash);
      await bridge.connected("svc");
      await until(async () => (await bridge.calledText("svc", "plain").catch(() => null)) === "called plain");
    }

    expect(levelsOf(bridge, "STDIO server exited with code 2")).toEqual(["warn", "warn"]);
  });

  it.each([
    ["a NUL in an env value, such as a stored credential", { env: { API_TOKEN: `${SECRET}\u0000` } }, 'env variable "API_TOKEN"'],
    ["an = in an env name, which would set another variable", { env: { "LD_PRELOAD=/tmp/evil.so:": SECRET } }, 'env variable "LD_PRELOAD=/tmp/evil.so:"'],
    ["a NUL in an argument", { args: ["server.js", `--token=${SECRET}\u0000`] }, "argument 2 has a NUL character"],
    ["a NUL in the command", { command: `${process.execPath}${SECRET}\u0000` }, "the command has a NUL character"],
    ["a NUL in the cwd", { cwd: `/tmp/${SECRET}\u0000` }, "cwd has a NUL character"],
    ["a stored credential with a NUL", { env: { API_TOKEN: "${credential:token}" } }, 'env variable "API_TOKEN"'],
  ])("refuses to start a server with %s, never showing the value", async (_case, extra, reason) => {
    await h.start((stub) => ({ svc: { command: process.execPath, args: [stub], _bridge: FAST_RECONNECT, ...extra } }));
    h.credentials.values.set("token", { type: "secret", value: `${SECRET}\u0000` });
    const bridge = await h.attach();

    await until(() => bridge.snapshots.get("svc")?.error !== undefined);
    expect(bridge.snapshots.get("svc")!.error).toContain(reason);
    expect(JSON.stringify([...bridge.snapshots.values(), ...bridge.logs])).not.toContain(SECRET);
    expect(await h.childPid()).toBeUndefined();
  });

  it("starts a command that can't be started once per attempt, not again as a legacy server", async () => {
    let spawns = 0;
    await h.start(() => ({ svc: { command: "/nonexistent/cbe-missing", _bridge: { reconnect: { reconnectBaseDelay: 60_000 } } } }), {
      _spawnChild: (options) => {
        spawns++;
        return new ChildHandle(options);
      },
    });
    const bridge = await h.attach();

    await until(() => bridge.snapshots.get("svc")?.status === "disconnected");

    expect(spawns).toBe(1);
    expect(levelsOf(bridge, "STDIO server could not be started")).toEqual(["warn"]);
  });

  it("connects as a legacy server one that quits when asked which protocol versions it speaks", async () => {
    await h.start(h.stubServer({}, { [STUB_EXIT_ON_DISCOVER_ENV]: "1" }));
    const bridge = await h.attach();

    await bridge.connected("svc", 15_000);

    expect(await bridge.calledText("svc", "plain")).toBe("called plain");
    expect((await h.status()).children[0]!.era).toBe("legacy");
    expect(bridge.logs.filter((log) => log.level === "warn")).toEqual([]);
    expect(h.telemetry().children.killedTotal.crash).toBe(0);
  });

  it("connects as a legacy server one that refuses the protocol version question and then quits, and remembers it", async () => {
    await h.start(h.stubServer({}, { [STUB_ERROR_THEN_EXIT_ON_DISCOVER_ENV]: "1" }));
    const bridge = await h.attach();

    await bridge.connected("svc", 15_000);
    const first = await h.childPid();
    await h.restartChild();
    const restarted = await h.nextChildPid(first);
    await until(async () => (await h.methods(restarted)).length > 0);

    expect(await bridge.calledText("svc", "plain")).toBe("called plain");
    expect((await h.methods(restarted))[0]).toBe("initialize");
    expect(bridge.logs.filter((log) => log.level === "warn")).toEqual([]);
  });

  it("asks a server again which protocol versions it speaks after it failed to connect as a legacy one", async () => {
    await h.start(h.stubServer({}, { [STUB_EXIT_ON_DISCOVER_ENV]: "1", [STUB_EXIT_ON_TOOLS_LIST_ENV]: "1" }));
    await h.attach();

    await until(async () => (await h.methods()).filter((method) => method === "server/discover").length >= 2, 10_000);
  });

  it("keeps what the protocol version question found when the server is restarted during it", async () => {
    await h.start(h.stubServer({}, { [STUB_IGNORE_DISCOVER_ENV]: "1" }));
    const bridge = await h.attach();
    await until(async () => (await h.methods()).includes("server/discover"));

    await h.restartChild();
    await bridge.connected("svc", 30_000);

    expect((await h.methods()).filter((method) => method === "server/discover")).toHaveLength(1);
    expect((await h.methods(await h.childPid()))[0]).toBe("initialize");
  });

  it("keeps a server legacy when it is restarted while it connects as one", async () => {
    await h.start((stub) => ({
      svc: {
        command: process.execPath,
        args: ["-e", `setTimeout(() => require(${JSON.stringify(stub)}), 2_000)`],
        env: { [STUB_METHOD_LOG_ENV]: h.methodLog, [STUB_IGNORE_DISCOVER_ENV]: "1" },
        _bridge: FAST_RECONNECT,
      },
    }));
    const bridge = await h.attach();
    const asked = await h.nextChildPid(undefined);
    const legacy = await h.nextChildPid(asked, 20_000);
    expect(await h.methods(legacy)).toEqual([]);

    await h.restartChild();
    await bridge.connected("svc", 30_000);

    expect((await h.methods()).filter((method) => method === "server/discover")).toHaveLength(1);
    expect((await h.methods(await h.childPid()))[0]).toBe("initialize");
  });

  it("remembers a server that ignores the protocol version question, starting it as legacy straight away after a restart", async () => {
    await h.start(h.stubServer({}, { [STUB_IGNORE_DISCOVER_ENV]: "1" }));
    const bridge = await h.attach();
    await bridge.connected("svc", 30_000);
    const pid = await h.childPid();

    await h.restartChild();
    const restarted = await h.nextChildPid(pid);
    await until(async () => (await h.methods(restarted)).length > 0, 5_000);

    expect((await h.methods(restarted))[0]).toBe("initialize");
  });

  it("records each process it starts and forgets each one it stops, and counts how they ended", async () => {
    const tracker = await h.recordingTracker();
    await h.start(h.stubServer(), { processTracker: tracker, graceMs: 50, idleMs: 50 });
    const bridge = await h.attach();
    await bridge.connected("svc");
    const first = (await h.childPid())!;

    await bridge.callTool("svc", "crash", { lines: [], code: 1 }).catch(() => {});
    const second = await h.nextChildPid(first);
    await h.restartChild();
    const third = await h.nextChildPid(second);
    bridge.close();
    await until(() => tracker.unregistered.includes(third));

    expect(tracker.registered).toEqual([first, second, third].map((pid) => ({ pid, command: process.execPath, server: "svc" })));
    expect(tracker.unregistered).toEqual([first, second, third]);
    expect(h.telemetry().children).toEqual({ total: 0, spawnedTotal: 3, killedTotal: { grace: 1, restart: 1, crash: 1, wedged: 0 } });
  });

  it("finishes a restart already under way before it stops, killing a server that ignores SIGTERM and forgetting it", async () => {
    const tracker = await h.recordingTracker();
    await h.start(h.sigtermIgnoringServer(), { killGraceMs: 300, processTracker: tracker });
    const bridge = await h.attach();
    await bridge.connected("svc");
    const pid = (await h.childPid())!;

    await h.restartChild();
    await h.fx!.manager.stop(0);

    expect(processExists(pid)).toBe(false);
    expect(tracker.unregistered).toContain(pid);
  });

  it("serves a bridge that attaches right after the last one left, while the old process is still being stopped", async () => {
    await h.start(h.stubServer(), { graceMs: 0, idleMs: 10, killGraceMs: 500 });
    const first = await h.attach();
    await first.connected("svc");

    first.close();
    await until(async () => (await h.status()).instances.length === 0);
    const second = await h.attach();

    await second.connected("svc");
    expect(await second.calledText("svc", "plain")).toBe("called plain");
  });

  it("lets a call finish on the old process when a reload changes the server, and sends the next one to the new process", async () => {
    await h.start(h.stubServer());
    const bridge = await h.attach();
    await bridge.connected("svc");
    const old = await h.childPid();
    const slow = bridge.callTool("svc", "slow", { ms: 1_000 });
    await until(async () => (await h.methods(old)).includes("tools/call"));

    const svc = h.configs[fixtureSource.path]!.svc as { args: string[] };
    svc.args = [...svc.args, "--changed"];
    await h.reloadByAttaching();

    await expect(slow).resolves.toMatchObject({ content: [{ text: "slow done" }] });
    await bridge.connected("svc");
    let replacement: number | undefined;
    await until(async () => (replacement = (await h.status()).children.find((child) => child.pid !== old)?.pid) !== undefined);
    expect(await bridge.calledText("svc", "plain")).toBe("called plain");
    expect(await h.methods(replacement)).toContain("tools/call");
  });

  it("sends a server's stderr only to the bridges of instances that use it", async () => {
    await h.start(h.stubServer());
    h.configs["/home/u/other.json"] = { other: { command: process.execPath, args: [h.stub, "--other"], _bridge: FAST_RECONNECT } };
    const using = await h.attach();
    const other = await h.attach({ source: { kind: "file", path: "/home/u/other.json" } });
    await using.connected("svc");
    await other.connected("other");

    await using.callTool("svc", "stderr", { text: "only for svc" });
    await until(() => using.logs.some((log) => log.message === "only for svc"));

    expect(other.logs.some((log) => log.message === "only for svc")).toBe(false);
  });
});
