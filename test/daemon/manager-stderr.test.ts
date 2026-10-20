import { afterEach, describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StatusResult } from "../../src/daemon/protocol.js";
import { processExists } from "../../src/process/process-utils.js";
import { STDERR_DRAIN_MS, STDERR_FORWARD_LINES_PER_SECOND } from "../../src/daemon/stderr-capture.js";
import { OpenSessionFixture, spawnTestManager, until, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import { STUB_STDIO_SERVER } from "../_helpers/stub-stdio-server.js";
import type { ManagerOptions } from "../../src/daemon/manager.js";

const isWindows = process.platform === "win32";
const BRIDGE_PROTOCOL_WITH_STDERR = 2;

describe.skipIf(isWindows)("stderr from a shared STDIO child", { timeout: 20_000 }, () => {
  let fx: DaemonFixture;
  let stub: string;
  const sessions: OpenSessionFixture[] = [];
  const grandchildren: number[] = [];
  let nextId = 1;

  afterEach(async () => {
    for (const pid of grandchildren.splice(0)) process.kill(pid, "SIGKILL");
    for (const session of sessions.splice(0)) await session.close();
    await fx.stop();
  });

  async function trackGrandchildHoldingStderr(session: OpenSessionFixture): Promise<void> {
    const announced = () => session.stderrLines.find((line) => line.startsWith("grandchild "));
    await until(() => announced() !== undefined);
    grandchildren.push(Number(announced()!.split(" ")[1]));
  }

  async function startManager(manager: Partial<ManagerOptions> = {}): Promise<void> {
    fx = await spawnTestManager({ manager });
    stub = join(fx.dir, "stub.cjs");
    await writeFile(stub, STUB_STDIO_SERVER);
  }

  async function request(session: OpenSessionFixture, method: string, params?: unknown) {
    const id = nextId++;
    session.sendRpc({ jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) });
    return (await session.waitForFrame((p) => (p as { id?: unknown }).id === id, 5_000)) as {
      result?: { content?: Array<{ text: string }> };
      error?: { message: string };
    };
  }

  async function openSession({ reportsProtocolVersion = true } = {}): Promise<OpenSessionFixture> {
    const bridgeProtocolVersion = reportsProtocolVersion ? BRIDGE_PROTOCOL_WITH_STDERR : undefined;
    const session = await OpenSessionFixture.open(fx, { command: process.execPath, args: [stub], bridgeProtocolVersion });
    sessions.push(session);
    await request(session, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    return session;
  }

  const evictionsOf = (session: OpenSessionFixture) => session.evictions.map((eviction) => eviction.params);

  function callTool(session: OpenSessionFixture, name: string, args: Record<string, unknown> = {}) {
    return request(session, "tools/call", { name, arguments: args });
  }

  async function calledPlain(session: OpenSessionFixture): Promise<string | undefined> {
    return (await callTool(session, "plain")).result?.content?.[0]?.text;
  }

  async function children() {
    return ((await fx.client.call("STATUS")) as StatusResult).children;
  }

  it("sends each stderr line to every bridge on the shared child", async () => {
    await startManager();
    const a = await openSession();
    const b = await openSession();

    await callTool(a, "stderr", { text: "warming cache" });
    await callTool(b, "stderr", { text: "cache ready" });

    await until(() => a.stderrLines.length === 2 && b.stderrLines.length === 2);
    expect(a.stderrLines).toEqual(["warming cache", "cache ready"]);
    expect(b.stderrLines).toEqual(["warming cache", "cache ready"]);
    expect(await children()).toHaveLength(1);
  });

  it("sends a child's stderr only to the bridges on that child", async () => {
    await startManager();
    const onFirst = await openSession();
    const onSecond = await OpenSessionFixture.open(fx, { command: process.execPath, args: [stub, "--second"], bridgeProtocolVersion: BRIDGE_PROTOCOL_WITH_STDERR });
    sessions.push(onSecond);
    await request(onSecond, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });

    await callTool(onFirst, "stderr", { text: "first child only" });
    await until(() => onFirst.stderrLines.length === 1);
    expect(await calledPlain(onSecond)).toBe("called plain");

    expect(await children()).toHaveLength(2);
    expect(onSecond.stderrLines).toEqual([]);
  });

  it("sends no stderr to a bridge that reports no protocol version, which keeps working", async () => {
    await startManager();
    const current = await openSession();
    const old = await openSession({ reportsProtocolVersion: false });

    await callTool(old, "stderr", { text: "only for current bridges" });
    await until(() => current.stderrLines.length === 1);

    expect(await calledPlain(old)).toBe("called plain");
    expect(old.stderrLines).toEqual([]);
  });

  it("tells each bridge how the child exited, with its last stderr lines, leaving them out for an older bridge", async () => {
    await startManager();
    const a = await openSession();
    const b = await openSession();
    const old = await openSession({ reportsProtocolVersion: false });
    await callTool(a, "stderr", { text: "starting up" });

    void callTool(a, "crash", { lines: ["Error: database is locked", "    at open (db.js:12)"], code: 2 }).catch(() => {});

    await until(() => [a, b, old].every((session) => evictionsOf(session).length === 1));
    const stopped = {
      reason: "child_exited",
      exit: { cause: "exited", code: 2, signal: null },
      stderr: ["starting up", "Error: database is locked", "    at open (db.js:12)"],
    };
    expect(evictionsOf(a)).toEqual([{ sessionId: a.sessionId, ...stopped }]);
    expect(evictionsOf(b)).toEqual([{ sessionId: b.sessionId, ...stopped }]);
    expect(evictionsOf(old)).toEqual([{ sessionId: old.sessionId, reason: "child_exited" }]);
  });

  it("sends only the child's last 20 stderr lines with its exit", async () => {
    await startManager();
    const session = await openSession();
    const lines = Array.from({ length: 25 }, (_, i) => `step ${i}`);

    void callTool(session, "crash", { lines, code: 1 }).catch(() => {});

    await until(() => evictionsOf(session).length === 1);
    expect(evictionsOf(session)[0]!.stderr).toEqual(lines.slice(-20));
  });

  it("reports a child that stopped answering pings as unresponsive, with its last stderr lines", async () => {
    await startManager({ childPingMs: 100, childPingTimeoutMs: 100, childPingMaxConsecutiveFailures: 2 });
    const session = await openSession();
    await callTool(session, "stderr", { text: "stuck waiting for lock" });

    await callTool(session, "ignore-pings");

    await until(() => evictionsOf(session).length === 1);
    expect(evictionsOf(session)).toEqual([
      {
        sessionId: session.sessionId,
        reason: "child_exited",
        exit: { cause: "unresponsive", code: null, signal: null },
        stderr: ["stuck waiting for lock"],
      },
    ]);
  });

  it("reports a child killed for flooding its stdout", async () => {
    await startManager();
    const session = await openSession();

    void callTool(session, "stdout-flood").catch(() => {});

    await until(() => evictionsOf(session).length === 1);
    expect(evictionsOf(session)[0]).toMatchObject({ exit: { cause: "output_flood", code: null, signal: null }, stderr: [] });
  });

  it("starts a new child for a bridge that opens while the exited one still has its stderr held open", async () => {
    await startManager({ _stderrDrainMs: 3_000 });
    const first = await openSession();
    const [dying] = await children();
    void callTool(first, "crash", { lines: ["shutting down"], code: 1, keepStderrOpen: true }).catch(() => {});
    await trackGrandchildHoldingStderr(first);
    await until(() => !processExists(dying!.pid));

    const second = await openSession();
    expect(evictionsOf(first)).toEqual([]);

    expect(await calledPlain(second)).toBe("called plain");
    expect((await children()).filter((child) => child.pid !== dying!.pid)).toHaveLength(1);

    await new Promise((r) => setTimeout(r, STDERR_DRAIN_MS + 200));
    expect(evictionsOf(first)).toEqual([]);

    await until(() => evictionsOf(first).length === 1);
    expect(await calledPlain(second)).toBe("called plain");
    expect(evictionsOf(second)).toEqual([]);

    await openSession();
    expect(await children()).toHaveLength(1);
  });

  it("reports the real exit, not a missed ping, for a child whose pings fail while its stderr is still open", async () => {
    await startManager({ _stderrDrainMs: 3_000, childPingMs: 100, childPingTimeoutMs: 200, childPingMaxConsecutiveFailures: 3 });
    const session = await openSession();
    void callTool(session, "crash", { lines: ["panic: nil map"], code: 1, keepStderrOpen: true }).catch(() => {});
    await trackGrandchildHoldingStderr(session);

    await until(() => evictionsOf(session).length === 1);

    expect(evictionsOf(session)[0]!.exit).toEqual({ cause: "exited", code: 1, signal: null });
  });

  it("reports a command that can't be started, with the reason as its last line, without waiting out the drain", async () => {
    await startManager();
    const command = join(fx.dir, "no-such-server");
    const openedAt = Date.now();
    const session = await OpenSessionFixture.open(fx, { command, args: [], bridgeProtocolVersion: BRIDGE_PROTOCOL_WITH_STDERR });
    sessions.push(session);

    await until(() => evictionsOf(session).length === 1);

    expect(Date.now() - openedAt).toBeLessThan(STDERR_DRAIN_MS);
    expect(evictionsOf(session)).toEqual([
      {
        sessionId: session.sessionId,
        reason: "child_exited",
        exit: { cause: "failed_to_start", code: null, signal: null },
        stderr: [`spawn ${command} ENOENT`],
      },
    ]);
    expect(session.stderrLines).toEqual([`spawn ${command} ENOENT`]);
  });

  it("sends no exit details when an admin restarts the child", async () => {
    await startManager();
    const session = await openSession();
    const [child] = await children();

    await fx.client.call("RESTART", { upstreamHash: child!.upstreamHash });

    await until(() => evictionsOf(session).length === 1);
    expect(evictionsOf(session)).toEqual([{ sessionId: session.sessionId, reason: "upstream_restarted" }]);
  });

  it("keeps a child that floods stderr answering, forwarding a bounded number of lines and how many it left out", async () => {
    await startManager();
    const session = await openSession();
    const [before] = await children();

    await callTool(session, "stderr-flood");
    const startedAt = Date.now();
    for (let call = 0; call < 5; call++) {
      expect(await calledPlain(session)).toBe("called plain");
      await new Promise((r) => setTimeout(r, 300));
    }
    const seconds = Math.ceil((Date.now() - startedAt) / 1_000) + 1;

    expect(session.stderrLines.length).toBeGreaterThanOrEqual(STDERR_FORWARD_LINES_PER_SECOND);
    expect(session.stderrLines.length).toBeLessThanOrEqual(seconds * STDERR_FORWARD_LINES_PER_SECOND);
    expect(session.stderrLines.some((line) => /^\(\d+ more stderr lines not shown\)$/.test(line))).toBe(true);
    expect((await children())[0]!.pid).toBe(before!.pid);
  });

  it("keeps a child writing one endless stderr line answering, forwarding that line once, cut off", async () => {
    await startManager();
    const session = await openSession();

    await callTool(session, "stderr-endless");
    await until(() => session.stderrLines.length > 0);
    await new Promise((r) => setTimeout(r, 500));

    expect(await calledPlain(session)).toBe("called plain");
    expect(session.stderrLines).toEqual([`${"y".repeat(1_000)} [truncated]`]);
  });

  it("sends an upstream log message to no bridge", async () => {
    await startManager();
    const a = await openSession();
    const b = await openSession();

    await callTool(a, "log-message");
    await calledPlain(b);

    for (const session of [a, b]) {
      expect(session.framesMatching((p) => (p as { method?: unknown }).method === "notifications/message")).toEqual([]);
    }
  });
});
