import { afterEach, describe, expect, it } from "vitest";
import { ChildHandle } from "../../../src/daemon/child-handle.js";
import { STDERR_FORWARD_LINES_PER_SECOND } from "../../../src/daemon/stderr-capture.js";
import { processExists } from "../../../src/process/process-utils.js";
import { until } from "../../_helpers/daemon-fixtures.js";
import { FAST_RECONNECT, StdioManagerHarness } from "../../_helpers/stdio-manager.js";
import { STUB_IGNORE_DISCOVER_ENV } from "../../_helpers/stub-stdio-server.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("STDIO upstreams in the manager", { timeout: 30_000 }, () => {
  const h = new StdioManagerHarness();

  afterEach(() => h.cleanUp());

  it("starts one child for two bridges on one config, initializing it and listing its tools once", async () => {
    await h.start(h.stubServer());
    const first = await h.attach();
    const second = await h.attach();
    await first.connected("svc");
    await second.connected("svc");

    expect(await first.calledText("svc", "plain")).toBe("called plain");
    expect(await second.calledText("svc", "plain")).toBe("called plain");
    const sent = await h.methods();
    expect(sent.filter((method) => method === "initialize")).toHaveLength(1);
    expect(sent.filter((method) => method === "tools/list")).toHaveLength(1);
    expect((await h.status()).children).toHaveLength(1);
  });

  it("lists the STDIO upstream and its child in STATUS", async () => {
    await h.start(h.stubServer());
    const bridge = await h.attach();
    await bridge.connected("svc");

    const reply = await h.status();
    expect(reply.upstreams).toEqual([{ serverName: "svc", type: "stdio", status: "connected", instances: 1, upstreamHash: reply.children[0]!.upstreamHash }]);
    expect(reply.instances[0]!.upstreams).toEqual(["svc"]);
    expect(reply.children).toEqual([
      expect.objectContaining({ serverName: "svc", era: "legacy", instances: 1, pid: expect.any(Number), upstreamHash: expect.any(String) }),
    ]);
  });

  it("warns every bridge with the last stderr lines when the child exits, then starts it again", async () => {
    await h.start(h.stubServer());
    const first = await h.attach();
    const second = await h.attach();
    await first.connected("svc");
    const pid = await h.childPid();

    await first.callTool("svc", "crash", { lines: ["boom"], code: 3 }).catch(() => {});

    for (const bridge of [first, second]) {
      await until(() => bridge.logs.some((log) => log.message === "STDIO server exited with code 3"));
      expect(bridge.logs.find((log) => log.message === "STDIO server exited with code 3")).toMatchObject({ level: "warn", stderr: ["boom"] });
    }
    await h.nextChildPid(pid);
    await first.connected("svc");
    expect(await first.calledText("svc", "plain")).toBe("called plain");
  });

  it("sends a stderr line to every attached bridge at debug level", async () => {
    await h.start(h.stubServer());
    const first = await h.attach();
    const second = await h.attach();
    await first.connected("svc");

    await first.callTool("svc", "stderr", { text: "hello from stderr" });

    for (const bridge of [first, second]) {
      await until(() => bridge.logs.some((log) => log.message === "hello from stderr"));
      expect(bridge.logs.find((log) => log.message === "hello from stderr")).toMatchObject({ upstream: "svc", level: "debug" });
    }
  });

  it("keeps a child that floods stderr answering, forwarding a bounded number of lines and how many it left out", async () => {
    await h.start(h.stubServer());
    const bridge = await h.attach();
    await bridge.connected("svc");
    const forwarded = () => bridge.logs.filter((log) => log.level === "debug");

    await bridge.callTool("svc", "stderr-flood");
    await until(() => forwarded().some((log) => /^\(\d+ more stderr lines not shown\)$/.test(log.message)), 3_000);

    expect(forwarded().length).toBeGreaterThanOrEqual(STDERR_FORWARD_LINES_PER_SECOND);
    expect(forwarded().length).toBeLessThanOrEqual(3 * (STDERR_FORWARD_LINES_PER_SECOND + 1));
    expect(await bridge.calledText("svc", "plain")).toBe("called plain");
  });

  it("stops a child that floods its stdout, saying so", async () => {
    await h.start(h.stubServer());
    const bridge = await h.attach();
    await bridge.connected("svc");

    await bridge.callTool("svc", "stdout-flood").catch(() => {});

    await until(() => bridge.logs.some((log) => log.message === "STDIO server sent a message too large to read and was stopped"));
  });

  it("reports a command that can't be started, with the reason", async () => {
    await h.start(() => ({ svc: { command: "/nonexistent/cbe-missing", _bridge: FAST_RECONNECT } }));
    const bridge = await h.attach();

    await until(() => bridge.logs.some((log) => log.message === "STDIO server could not be started"));
    const warning = bridge.logs.find((log) => log.message === "STDIO server could not be started")!;
    expect(warning.stderr?.join("\n")).toContain("ENOENT");
    expect(bridge.snapshots.get("svc")?.status).not.toBe("connected");
  });

  it("starts a child that stops answering pings again, saying why", async () => {
    await h.start(h.stubServer(), { childPingMs: 50, childPingTimeoutMs: 50, childPingMaxConsecutiveFailures: 2 });
    const bridge = await h.attach();
    await bridge.connected("svc");
    const pid = (await h.childPid())!;

    await bridge.callTool("svc", "ignore-pings");

    await until(() => bridge.logs.some((log) => log.message === "STDIO server stopped answering and was stopped"));
    await h.nextChildPid(pid);
    expect(processExists(pid)).toBe(false);
  });

  it("keeps a child for graceMs after its last instance closes, reusing it for a new one", async () => {
    await h.start(h.stubServer(), { graceMs: 60_000, idleMs: 100 });
    const first = await h.attach();
    await first.connected("svc");
    const pid = (await h.childPid())!;

    first.close();
    await until(async () => (await h.status()).instances.length === 0);
    expect((await h.status()).children.map((child) => child.pid)).toEqual([pid]);
    const second = await h.attach();
    await second.connected("svc");

    expect((await h.status()).children.map((child) => child.pid)).toEqual([pid]);
  });

  it("stops a child graceMs after its last instance closes, and the manager once idle", async () => {
    await h.start(h.stubServer(), { graceMs: 200, idleMs: 100 });
    const bridge = await h.attach();
    await bridge.connected("svc");
    const pid = (await h.childPid())!;

    bridge.close();
    h.fx!.client.close();
    await until(() => !processExists(pid));

    expect(await h.fx!.manager.waitForExit()).toBe(0);
  });

  it("restarts a child by its hash, and every bridge reconnects", async () => {
    await h.start(h.stubServer());
    const first = await h.attach();
    const second = await h.attach();
    await first.connected("svc");
    const [child] = (await h.status()).children;

    expect(await h.fx!.client.call("RESTART", { upstreamHash: child!.upstreamHash })).toEqual({ ok: true, restarted: 1 });

    await h.nextChildPid(child!.pid);
    await first.connected("svc");
    expect(await first.calledText("svc", "plain")).toBe("called plain");
    expect(await second.calledText("svc", "plain")).toBe("called plain");
    expect(await h.fx!.client.call("RESTART", { upstreamHash: "unknown" })).toEqual({ ok: true, restarted: 0 });
  });

  it("stops listing a child it is restarting as soon as the restart begins", async () => {
    await h.start(h.sigtermIgnoringServer(), { killGraceMs: 2_000 });
    const bridge = await h.attach();
    await bridge.connected("svc");
    const pid = (await h.childPid())!;

    await h.restartChild();

    expect((await h.status()).children.map((child) => child.pid)).not.toContain(pid);
    expect(processExists(pid)).toBe(true);
  });

  it("stops its children when it stops, killing one that ignores SIGTERM", async () => {
    await h.start(h.sigtermIgnoringServer(), { killGraceMs: 200 });
    const bridge = await h.attach();
    await bridge.connected("svc");
    const pid = (await h.childPid())!;

    await h.fx!.manager.stop(0);

    expect(processExists(pid)).toBe(false);
  });

  it("refuses a relative cwd with an error on the upstream", async () => {
    await h.start(h.stubServer({ cwd: "relative/dir" }));
    const bridge = await h.attach();

    await until(() => bridge.snapshots.get("svc")?.error !== undefined);
    expect(bridge.snapshots.get("svc")!.error).toContain("cwd must be an absolute path");
  });

  it("shows a missing credential as the upstream's error", async () => {
    await h.start(h.stubServer({ env: { TOKEN: "${credential:absent}" } }));
    const bridge = await h.attach();

    await until(() => bridge.snapshots.get("svc")?.error !== undefined);
    expect(bridge.snapshots.get("svc")!.error).toContain('Credential "absent" not found');
  });

  it("connects once the missing credential is stored, passing its value to the new process", async () => {
    await h.start(h.stubServer({ env: { TOKEN: "${credential:absent}" } }));
    const bridge = await h.attach();
    await until(() => bridge.snapshots.get("svc")?.error !== undefined);

    h.credentials.values.set("absent", { type: "secret", value: "stored-now" });

    await bridge.connected("svc");
    expect(JSON.parse((await bridge.calledText("svc", "env"))!).TOKEN).toBe("stored-now");
  });

  it("restarts a STDIO server that can't start, by the hash STATUS shows for its upstream", async () => {
    await h.start(() => ({ svc: { command: "/nonexistent/cbe-missing", _bridge: FAST_RECONNECT } }));
    const bridge = await h.attach();
    await until(() => bridge.snapshots.get("svc")?.error !== undefined);
    const [upstream] = (await h.status()).upstreams;
    if (upstream?.type !== "stdio") throw new Error("expected a STDIO upstream");

    expect((await h.status()).children).toEqual([]);
    expect(await h.fx!.client.call("RESTART", { upstreamHash: upstream.upstreamHash })).toEqual({ ok: true, restarted: 1 });
  });

  it("sends only the child's last 20 stderr lines with its exit", async () => {
    await h.start(h.stubServer());
    const bridge = await h.attach();
    await bridge.connected("svc");
    const lines = Array.from({ length: 25 }, (_, i) => `step ${i}`);

    await bridge.callTool("svc", "crash", { lines, code: 1 }).catch(() => {});

    await until(() => bridge.logs.some((log) => log.message === "STDIO server exited with code 1"));
    expect(bridge.logs.find((log) => log.message === "STDIO server exited with code 1")!.stderr).toEqual(lines.slice(-20));
  });

  it("forwards an endless stderr line once, cut off", async () => {
    await h.start(h.stubServer());
    const bridge = await h.attach();
    await bridge.connected("svc");

    await bridge.callTool("svc", "stderr-endless");
    await until(() => bridge.logs.some((log) => log.level === "debug"));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await bridge.calledText("svc", "plain")).toBe("called plain");
    expect(bridge.logs.filter((log) => log.level === "debug").map((log) => log.message)).toEqual([`${"y".repeat(1_000)} [truncated]`]);
  });

  it("sends an upstream's log notifications to no bridge", async () => {
    await h.start(h.stubServer());
    const bridge = await h.attach();
    await bridge.connected("svc");

    await bridge.callTool("svc", "log-message");
    await bridge.calledText("svc", "plain");

    expect(bridge.logs.filter((log) => log.message.includes("upstream log"))).toEqual([]);
  });

  it("kills a child that closes its stdout but keeps running, and forgets its pid", async () => {
    const tracker = await h.recordingTracker();
    await h.start(h.stubServer(), { processTracker: tracker });
    const bridge = await h.attach();
    await bridge.connected("svc");
    const pid = (await h.childPid())!;

    await bridge.callTool("svc", "close-stdout");

    await until(() => tracker.unregistered.includes(pid));
    expect(processExists(pid)).toBe(false);
  });

  it("waits for a slow kill and the process record when it stops, and counts no kill for it", async () => {
    const tracker = await h.recordingTracker(300);
    await h.start(h.sigtermIgnoringServer(), { killGraceMs: 300, processTracker: tracker });
    const bridge = await h.attach();
    await bridge.connected("svc");
    const pid = (await h.childPid())!;

    await h.fx!.manager.stop(0);

    expect(processExists(pid)).toBe(false);
    expect(tracker.unregistered).toContain(pid);
    expect(h.telemetry().children.killedTotal).toEqual({ grace: 0, restart: 0, crash: 0, wedged: 0 });
  });

  it.each([
    [50, true],
    [0, false],
  ])("pings each child every childPingMs, here %i, and not at all for 0", async (childPingMs, pinged) => {
    await h.start(h.stubServer(), { childPingMs });
    const bridge = await h.attach();
    await bridge.connected("svc");

    if (pinged) await until(async () => (await h.methods()).includes("ping"));
    else await new Promise((resolve) => setTimeout(resolve, 300));

    expect((await h.methods()).includes("ping")).toBe(pinged);
  });

  it("fails a call too large for the server's stdin queue, and serves the next one", async () => {
    await h.start(h.stubServer(), { _spawnChild: (options) => new ChildHandle({ ...options, queueMaxBytes: 4_096 }) });
    const bridge = await h.attach();
    await bridge.connected("svc");

    await expect(bridge.callTool("svc", "plain", { blob: "x".repeat(8_192) })).rejects.toThrow("child stdin queue would exceed 4096 bytes");

    expect(await bridge.calledText("svc", "plain")).toBe("called plain");
  });

  it("connects a legacy server that ignores the protocol version question, once the question times out", { timeout: 40_000 }, async () => {
    await h.start(h.stubServer({}, { [STUB_IGNORE_DISCOVER_ENV]: "1" }));
    const bridge = await h.attach();

    await bridge.connected("svc", 30_000);

    expect(await bridge.calledText("svc", "plain")).toBe("called plain");
    expect((await h.methods()).slice(0, 3)).toEqual(["server/discover", "initialize", "notifications/initialized"]);
  });

  it("fails a call the server exits during, saying it exited", async () => {
    await h.start(h.stubServer());
    const bridge = await h.attach();
    await bridge.connected("svc");

    await expect(bridge.callTool("svc", "crash", { lines: [], code: 1 })).rejects.toThrow("child process exited");
  });
});
