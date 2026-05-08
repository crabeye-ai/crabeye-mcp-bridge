import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { AutoForkOrchestrator } from "../../src/daemon/auto-fork.js";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { createNoopLogger } from "../../src/logging/index.js";
import type { ChildGroup } from "../../src/daemon/manager.js";

const isWindows = process.platform === "win32";

async function tempPaths(): Promise<{ dir: string; sock: string; pid: string; lock: string; proc: string }> {
  const dir = await mkdtemp("/tmp/cbe-mgr-autofork-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

function freshClient(paths: { sock: string }): DaemonClient {
  return new DaemonClient({
    socketPath: paths.sock,
    transport: netTransport,
    rpcTimeoutMs: 1_000,
    connectTimeoutMs: 1_000,
  });
}

function defaultSpec(sharing: "auto" | "shared" | "dedicated"): {
  serverName: string;
  command: string;
  args: string[];
  resolvedEnv: Record<string, string>;
  cwd: string;
  sharing: "auto" | "shared" | "dedicated";
  clientInfo: { name: string; version: string };
  clientCapabilities: Record<string, unknown>;
  protocolVersion: string;
} {
  return {
    serverName: "x",
    command: "node",
    args: ["-e", "process.stdin.on('data', () => {})"],
    resolvedEnv: {},
    cwd: "",
    sharing,
    clientInfo: { name: "test-bridge", version: "0.0.0" },
    clientCapabilities: {},
    protocolVersion: "2025-06-18",
  };
}

function freshManagerWithCaptureChild(
  paths: { sock: string; pid: string; lock: string; proc: string },
  childWrites: unknown[],
): ManagerDaemon {
  return new ManagerDaemon({
    socketPath: paths.sock,
    pidPath: paths.pid,
    lockPath: paths.lock,
    idleMs: 60_000,
    transport: netTransport,
    processTrackerPath: paths.proc,
    _spawnChild: (_spec, _cb) => {
      void _cb;
      // Use a fake child whose `send` records writes.
      return {
        startedAt: Date.now(),
        pid: 99999,
        alive: true,
        cachedInit: null,
        setCachedInit() {},
        send(payload: unknown) {
          childWrites.push(payload);
        },
        async kill() {},
      } as never;
    },
  });
}

describe("AutoForkOrchestrator — detection", () => {
  function freshOrchestrator(): AutoForkOrchestrator {
    return new AutoForkOrchestrator({
      logger: createNoopLogger(),
      sendToChild: () => {},
      sendToSession: () => {},
      warnedShared: new Set<string>(),
      taintAuto: () => {},
      delistShareable: () => {},
      spawnDedicatedForSession: () => null,
      getAttachment: () => undefined,
      nextInternalId: () => -1,
      registerInternal: () => {},
      unregisterInternal: () => {},
      killGroup: () => {},
      evictSession: () => {},
      urisForSession: () => [],
      registerSubscription: () => {},
      attemptCompleteMigration: () => {},
      completeMigration: () => {},
      synthDrainTimeoutErrors: () => {},
      autoForkInitializeTimeoutMs: 1_000,
      autoForkDrainTimeoutMs: 60_000,
    });
  }

  it("isServerRequest returns true for requests with method+id (numeric)", () => {
    const orch = freshOrchestrator();
    expect(
      orch.isServerRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "sampling/createMessage",
        params: {},
      }),
    ).toBe(true);
  });

  it("isServerRequest returns true for requests with method+id (string)", () => {
    const orch = freshOrchestrator();
    expect(
      orch.isServerRequest({
        jsonrpc: "2.0",
        id: "abc",
        method: "roots/list",
      }),
    ).toBe(true);
  });

  it("isServerRequest returns false for notifications (no id)", () => {
    const orch = freshOrchestrator();
    expect(
      orch.isServerRequest({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      }),
    ).toBe(false);
  });

  it("isServerRequest returns false for responses (no method)", () => {
    const orch = freshOrchestrator();
    expect(
      orch.isServerRequest({ jsonrpc: "2.0", id: 1, result: {} }),
    ).toBe(false);
  });

  it("isServerRequest returns false for non-objects", () => {
    const orch = freshOrchestrator();
    expect(orch.isServerRequest(null)).toBe(false);
    expect(orch.isServerRequest("a string")).toBe(false);
    expect(orch.isServerRequest(42)).toBe(false);
    expect(orch.isServerRequest(undefined)).toBe(false);
  });
});

describe("AutoForkOrchestrator — shared/dedicated dispatch", () => {
  function fakeGroup(opts: {
    sharing: "auto" | "shared" | "dedicated";
    sessions: string[];
    upstreamHash?: string;
    groupId?: string;
  }): ChildGroup {
    return {
      groupId: opts.groupId ?? "g1",
      upstreamHash: opts.upstreamHash ?? "hash-1",
      child: {} as never,
      rewriter: {} as never,
      subscriptions: {} as never,
      router: {} as never,
      sessions: new Set(opts.sessions),
      serverName: "stub",
      startedAt: 0,
      graceTimer: null,
      dying: false,
      initializedSeen: false,
      mode: opts.sharing === "dedicated" ? "dedicated" : "shared",
      sharing: opts.sharing,
      forked: false,
      internalRequests: new Map(),
      nextInternalId: -1,
    };
  }

  function noopDeps(): {
    logger: ReturnType<typeof createNoopLogger>;
    sendToChild: () => void;
    sendToSession: () => void;
    warnedShared: Set<string>;
    taintAuto: () => void;
    delistShareable: () => void;
    spawnDedicatedForSession: () => null;
    getAttachment: () => undefined;
    nextInternalId: () => number;
    registerInternal: () => void;
    unregisterInternal: () => void;
    killGroup: () => void;
    evictSession: () => void;
    urisForSession: () => string[];
    registerSubscription: () => void;
    attemptCompleteMigration: () => void;
    completeMigration: () => void;
    synthDrainTimeoutErrors: () => void;
    autoForkInitializeTimeoutMs: number;
    autoForkDrainTimeoutMs: number;
  } {
    return {
      logger: createNoopLogger(),
      sendToChild: () => {},
      sendToSession: () => {},
      warnedShared: new Set<string>(),
      taintAuto: () => {},
      delistShareable: () => {},
      spawnDedicatedForSession: () => null,
      getAttachment: () => undefined,
      nextInternalId: () => -1,
      registerInternal: () => {},
      unregisterInternal: () => {},
      killGroup: () => {},
      evictSession: () => {},
      urisForSession: () => [],
      registerSubscription: () => {},
      attemptCompleteMigration: () => {},
      completeMigration: () => {},
      synthDrainTimeoutErrors: () => {},
      autoForkInitializeTimeoutMs: 1_000,
      autoForkDrainTimeoutMs: 60_000,
    };
  }

  it("shared mode: emits -32601 to child via sendToChild; no session delivery", async () => {
    const childSends: Array<{ group: ChildGroup; payload: unknown }> = [];
    const sessionSends: Array<{ group: ChildGroup; sessionId: string; payload: unknown }> = [];

    const orch = new AutoForkOrchestrator({
      ...noopDeps(),
      sendToChild: (group, payload) => childSends.push({ group, payload }),
      sendToSession: (group, sessionId, payload) =>
        sessionSends.push({ group, sessionId, payload }),
    });

    const group = fakeGroup({ sharing: "shared", sessions: ["s1", "s2"] });
    await orch.handleServerRequest(group, {
      jsonrpc: "2.0",
      id: 42,
      method: "sampling/createMessage",
      params: {},
    });

    expect(childSends).toHaveLength(1);
    expect(childSends[0]!.group).toBe(group);
    expect(childSends[0]!.payload).toEqual({
      jsonrpc: "2.0",
      id: 42,
      error: { code: -32601, message: expect.stringContaining("sampling/createMessage") },
    });
    expect(sessionSends).toEqual([]);
  });

  it("shared mode: warns ONCE per (group, method) pair", async () => {
    const warnings: string[] = [];
    const fakeLogger = {
      info: () => {},
      warn: (msg: string) => warnings.push(msg),
      debug: () => {},
      error: () => {},
      child: () => fakeLogger,
    } as never;

    const warnedShared = new Set<string>();
    const orch = new AutoForkOrchestrator({
      ...noopDeps(),
      logger: fakeLogger,
      warnedShared,
    });

    const group = fakeGroup({ sharing: "shared", sessions: ["s1"] });
    const payload = { jsonrpc: "2.0", id: 1, method: "sampling/createMessage", params: {} };
    await orch.handleServerRequest(group, payload);
    await orch.handleServerRequest(group, payload);
    await orch.handleServerRequest(group, payload);
    expect(warnings).toHaveLength(1);

    // Different method on the same group → another warn.
    await orch.handleServerRequest(group, { ...payload, method: "roots/list" });
    expect(warnings).toHaveLength(2);
  });

  it("dedicated mode: forwards request to single attached session", async () => {
    const childSends: Array<{ group: ChildGroup; payload: unknown }> = [];
    const sessionSends: Array<{ group: ChildGroup; sessionId: string; payload: unknown }> = [];

    const orch = new AutoForkOrchestrator({
      ...noopDeps(),
      sendToChild: (group, payload) => childSends.push({ group, payload }),
      sendToSession: (group, sessionId, payload) =>
        sessionSends.push({ group, sessionId, payload }),
    });

    const group = fakeGroup({ sharing: "dedicated", sessions: ["only-session"] });
    const payload = { jsonrpc: "2.0", id: 7, method: "elicitation/create", params: {} };
    await orch.handleServerRequest(group, payload);

    expect(sessionSends).toHaveLength(1);
    expect(sessionSends[0]!.sessionId).toBe("only-session");
    expect(sessionSends[0]!.payload).toBe(payload);
    expect(childSends).toEqual([]);
  });

  it("auto mode: triggers fork (delegates to fork sequence)", async () => {
    // With getAttachment returning undefined and spawnDedicated returning null,
    // fork should run with no migrations and not throw. The triggering request
    // should be forwarded to the originating (first-attached) session via
    // sendToSession.
    const sessionSends: Array<{ sessionId: string; payload: unknown }> = [];
    const taints: string[] = [];
    const delists: string[] = [];

    const orch = new AutoForkOrchestrator({
      ...noopDeps(),
      sendToSession: (_group, sessionId, payload) => sessionSends.push({ sessionId, payload }),
      taintAuto: (hash) => taints.push(hash),
      delistShareable: (group) => delists.push(group.upstreamHash),
    });

    const group = fakeGroup({ sharing: "auto", sessions: ["s1", "s2"] });
    const payload = { jsonrpc: "2.0", id: 1, method: "foo/bar" };
    await expect(orch.handleServerRequest(group, payload)).resolves.toBeUndefined();

    // Group flipped to dedicated, forked=true, hash tainted, delisted.
    expect(group.mode).toBe("dedicated");
    expect(group.forked).toBe(true);
    expect(taints).toEqual(["hash-1"]);
    expect(delists).toEqual(["hash-1"]);

    // Triggering request forwarded to originating session (first-attached: s1).
    expect(sessionSends).toEqual([{ sessionId: "s1", payload }]);
  });
});

describe.skipIf(isWindows)("AutoForkOrchestrator — outbound buffering (Phase D)", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });
  afterEach(async () => {
    if (manager !== null) await manager.stop(0).catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  it("draining session: outbound is buffered, not forwarded to child", async () => {
    const childWrites: unknown[] = [];
    manager = freshManagerWithCaptureChild(paths, childWrites);
    await manager.start();
    const c = freshClient(paths);
    try {
      await c.connect();
      const responses: unknown[] = [];
      c.setNotificationHandler((notif) => {
        if (notif.method === "RPC") responses.push((notif.params as { payload: unknown }).payload);
      });
      const sid = "11111111-1111-1111-1111-111111111111";
      await c.call("OPEN", { sessionId: sid, spec: defaultSpec("auto") });

      // Force the session into draining state with a stub new group.
      const fakeNewGroup = {} as never;
      manager.setMigrationStateForTest(sid, {
        kind: "draining",
        newGroup: fakeNewGroup,
        queuedOutbound: [],
        drainDeadline: Date.now() + 60_000,
        drainTimer: null,
        replayDone: false,
      });

      const initialChildWrites = childWrites.length;

      // Send an outbound RPC; should be buffered, not forwarded.
      c.sendNotification("RPC", {
        sessionId: sid,
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(childWrites.length).toBe(initialChildWrites);
      // Bridge should NOT have received any RPC error response yet.
      expect(responses).toEqual([]);
    } finally {
      c.close();
    }
  });

  it("draining session: 257th queued payload returns DRAIN_BACKPRESSURE", async () => {
    const childWrites: unknown[] = [];
    manager = freshManagerWithCaptureChild(paths, childWrites);
    await manager.start();
    const c = freshClient(paths);
    try {
      await c.connect();
      const errors: Array<{ id: unknown; error: { code: number } }> = [];
      c.setNotificationHandler((notif) => {
        if (notif.method !== "RPC") return;
        const payload = (notif.params as { payload: { error?: { code: number }; id?: unknown } }).payload;
        if (payload.error !== undefined) {
          errors.push({ id: payload.id, error: payload.error });
        }
      });
      const sid = "22222222-2222-2222-2222-222222222222";
      await c.call("OPEN", { sessionId: sid, spec: defaultSpec("auto") });
      manager.setMigrationStateForTest(sid, {
        kind: "draining",
        newGroup: {} as never,
        queuedOutbound: [],
        drainDeadline: Date.now() + 60_000,
        drainTimer: null,
        replayDone: false,
      });

      // Push 256 payloads — all queued silently.
      for (let i = 1; i <= 256; i++) {
        c.sendNotification("RPC", {
          sessionId: sid,
          payload: { jsonrpc: "2.0", id: i, method: "tools/list", params: {} },
        });
      }
      // 257th — should return DRAIN_BACKPRESSURE.
      c.sendNotification("RPC", {
        sessionId: sid,
        payload: { jsonrpc: "2.0", id: 257, method: "tools/list", params: {} },
      });
      await new Promise((r) => setTimeout(r, 100));

      expect(errors).toEqual([{ id: 257, error: { code: -32003, message: expect.any(String) } }]);
    } finally {
      c.close();
    }
  });
});

describe.skipIf(isWindows)("AutoForkOrchestrator — fork sequence (Phase D)", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });
  afterEach(async () => {
    if (manager !== null) await manager.stop(0).catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  it("fork: originating session keeps old child; non-originating sessions get fresh children with replayed initialize", async () => {
    const childWritesByPid = new Map<number, unknown[]>();
    let nextPid = 1000;

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: (_spec, cb) => {
        const pid = nextPid++;
        const writes: unknown[] = [];
        childWritesByPid.set(pid, writes);
        const handle = {
          startedAt: Date.now(),
          pid,
          alive: true,
          cachedInit: null as unknown,
          setCachedInit(init: unknown): void {
            handle.cachedInit = init;
          },
          send(payload: unknown): void {
            writes.push(payload);
            // Auto-respond to daemon-issued initialize (negative id) with success.
            const p = payload as { id?: number; method?: string };
            if (typeof p.id === "number" && p.id < 0 && p.method === "initialize") {
              setTimeout(() => {
                cb.onMessage({
                  jsonrpc: "2.0",
                  id: p.id,
                  result: {
                    protocolVersion: "2025-06-18",
                    serverInfo: { name: "stub", version: "1.0.0" },
                    capabilities: { tools: { listChanged: true } },
                  },
                });
              }, 5);
            }
          },
          async kill(): Promise<void> {},
        };
        return handle as never;
      },
    });
    await manager.start();

    // Two bridges (B1 and B2) each open one auto session.
    const c1 = freshClient(paths);
    const c2 = freshClient(paths);
    try {
      await c1.connect();
      await c2.connect();
      const sid1 = "11111111-1111-1111-1111-111111111111";
      const sid2 = "22222222-2222-2222-2222-222222222222";

      // Capture inbound RPC payloads on both bridges.
      const c1RpcPayloads: unknown[] = [];
      const c2RpcPayloads: unknown[] = [];
      c1.setNotificationHandler((n) => {
        if (n.method === "RPC") c1RpcPayloads.push((n.params as { payload: unknown }).payload);
      });
      c2.setNotificationHandler((n) => {
        if (n.method === "RPC") c2RpcPayloads.push((n.params as { payload: unknown }).payload);
      });

      await c1.call("OPEN", { sessionId: sid1, spec: defaultSpec("auto") });
      await c2.call("OPEN", { sessionId: sid2, spec: defaultSpec("auto") });

      // Both sessions on the same shared child (refcount 2).
      const status0 = (await c1.call("STATUS")) as {
        children: Array<{ refcount: number; sessions: string[]; pid: number; mode: string }>;
      };
      expect(status0.children).toHaveLength(1);
      const oldChildPid = status0.children[0]!.pid;

      // Synthesize a server→client request from the shared child via test seam.
      manager.spawnedChildEmitForTest({
        jsonrpc: "2.0",
        id: 100,
        method: "sampling/createMessage",
        params: { messages: [] },
      });

      // Wait for fork orchestration to finish (initialize replay via setTimeout(5ms)).
      await new Promise((r) => setTimeout(r, 100));

      // Status now: 2 children — old still around with sid1, new dedicated for sid2.
      const status1 = (await c1.call("STATUS")) as {
        children: Array<{
          refcount: number;
          sessions: string[];
          pid: number;
          mode: string;
          sharing: string;
          forked: boolean;
        }>;
      };
      expect(status1.children.length).toBeGreaterThanOrEqual(2);

      // Old child (pid = oldChildPid) should now have mode=dedicated, sessions=[sid1], forked=true.
      const oldChild = status1.children.find((c) => c.pid === oldChildPid);
      expect(oldChild).toBeDefined();
      expect(oldChild!.mode).toBe("dedicated");
      expect(oldChild!.sessions).toEqual([sid1]);
      expect(oldChild!.forked).toBe(true);

      // New child for sid2: mode=dedicated, sessions=[sid2], forked=false.
      const newChild = status1.children.find(
        (c) => c.pid !== oldChildPid && c.sessions.includes(sid2),
      );
      expect(newChild).toBeDefined();
      expect(newChild!.mode).toBe("dedicated");
      expect(newChild!.sessions).toEqual([sid2]);
      expect(newChild!.forked).toBe(false);

      // Triggering request should have reached originating bridge (sid1's bridge = c1).
      const trigger = c1RpcPayloads.find(
        (p) => (p as { method?: string }).method === "sampling/createMessage",
      );
      expect(trigger).toBeDefined();
      expect((trigger as { id?: unknown }).id).toBe(100);

      // Initialize replay should have been issued against new child (negative id).
      const newChildPid = newChild!.pid;
      const newChildWrites = childWritesByPid.get(newChildPid)!;
      const replayInit = newChildWrites.find(
        (w) =>
          (w as { method?: string; id?: number }).method === "initialize" &&
          typeof (w as { id?: number }).id === "number" &&
          (w as { id: number }).id < 0,
      );
      expect(replayInit).toBeDefined();
      expect(
        (
          replayInit as {
            params: {
              protocolVersion: string;
              clientInfo: { name: string };
              capabilities: object;
            };
          }
        ).params,
      ).toMatchObject({
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-bridge", version: "0.0.0" },
        capabilities: {},
      });

      // Hash should now be tainted: a new auto OPEN with same hash spawns fresh dedicated.
      const c3 = freshClient(paths);
      await c3.connect();
      const sid3 = "33333333-3333-3333-3333-333333333333";
      await c3.call("OPEN", { sessionId: sid3, spec: defaultSpec("auto") });
      const status2 = (await c3.call("STATUS")) as import("../../src/daemon/protocol.js").StatusResult;
      const sid3Child = status2.children.find((c) => c.sessions.includes(sid3));
      expect(sid3Child).toBeDefined();
      expect(sid3Child!.mode).toBe("dedicated");
      expect(sid3Child!.pid).not.toBe(oldChildPid);
      // Telemetry: exactly one fork event per upstreamHash non-shareable transition.
      expect(status2.telemetry.fork.eventsTotal).toBe(1);
      c3.close();
    } finally {
      c1.close();
      c2.close();
    }
  });
});

describe.skipIf(isWindows)("AutoForkOrchestrator — subscribe replay + completion (Phase D)", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });
  afterEach(async () => {
    if (manager !== null) await manager.stop(0).catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  it("fork: replays resources/subscribe for each tracked URI on the new child", async () => {
    const writesByPid = new Map<number, unknown[]>();
    let nextPid = 2000;

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: (_spec, cb) => {
        const pid = nextPid++;
        const writes: unknown[] = [];
        writesByPid.set(pid, writes);
        const handle = {
          startedAt: Date.now(),
          pid,
          alive: true,
          cachedInit: null as unknown,
          setCachedInit(init: unknown): void {
            handle.cachedInit = init;
          },
          send(payload: unknown): void {
            writes.push(payload);
            const p = payload as { id?: number; method?: string };
            if (typeof p.id === "number" && p.id < 0) {
              // Auto-respond to internal requests.
              setTimeout(() => {
                if (p.method === "initialize") {
                  cb.onMessage({
                    jsonrpc: "2.0",
                    id: p.id,
                    result: {
                      protocolVersion: "2025-06-18",
                      serverInfo: { name: "stub", version: "1" },
                      capabilities: {},
                    },
                  });
                } else if (p.method === "resources/subscribe") {
                  cb.onMessage({ jsonrpc: "2.0", id: p.id, result: {} });
                }
              }, 5);
            }
          },
          async kill(): Promise<void> {},
        };
        return handle as never;
      },
    });
    await manager.start();

    const c1 = freshClient(paths);
    const c2 = freshClient(paths);
    try {
      await c1.connect();
      await c2.connect();
      const sid1 = "11111111-1111-1111-1111-111111111111";
      const sid2 = "22222222-2222-2222-2222-222222222222";
      await c1.call("OPEN", { sessionId: sid1, spec: defaultSpec("auto") });
      await c2.call("OPEN", { sessionId: sid2, spec: defaultSpec("auto") });

      // Subscribe sid2 to two URIs on the shared child via the proper RPC path.
      // After AIT-247 each subscribe goes through subscription-tracker dedupe.
      c2.sendNotification("RPC", {
        sessionId: sid2,
        payload: { jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: { uri: "file:///a" } },
      });
      c2.sendNotification("RPC", {
        sessionId: sid2,
        payload: { jsonrpc: "2.0", id: 2, method: "resources/subscribe", params: { uri: "file:///b" } },
      });
      await new Promise((r) => setTimeout(r, 50));

      // Trigger fork.
      manager.spawnedChildEmitForTest({
        jsonrpc: "2.0",
        id: 100,
        method: "sampling/createMessage",
        params: {},
      });
      await new Promise((r) => setTimeout(r, 200));

      // Find new child's writes; expect TWO subscribe replays + one initialize + one initialized.
      const status = (await c1.call("STATUS")) as {
        children: Array<{ pid: number; sessions: string[] }>;
      };
      const newChild = status.children.find((c) => c.sessions.includes(sid2));
      expect(newChild).toBeDefined();
      const newChildWrites = writesByPid.get(newChild!.pid)!;
      const subscribeReplays = newChildWrites.filter(
        (w) => (w as { method?: string }).method === "resources/subscribe",
      );
      expect(subscribeReplays).toHaveLength(2);
      const replayedUris = subscribeReplays
        .map((w) => (w as { params: { uri: string } }).params.uri)
        .sort();
      expect(replayedUris).toEqual(["file:///a", "file:///b"]);
    } finally {
      c1.close();
      c2.close();
    }
  });

  it("fork: migration completes when old-child inflight reaches zero", async () => {
    // We'll have sid2 with one outstanding bridge→child request on the old shared child.
    // After fork triggers and replay completes, migration stays "draining" until
    // the old child responds. Simulate: stub's onMessage for old child responds
    // to the inflight after a short delay.
    let oldChildOnMessage: ((p: unknown) => void) | null = null;
    let nextPid = 3000;
    const writesByPid = new Map<number, unknown[]>();
    let firstChild = true;

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: (_spec, cb) => {
        const isFirst = firstChild;
        firstChild = false;
        const pid = nextPid++;
        const writes: unknown[] = [];
        writesByPid.set(pid, writes);
        if (isFirst) oldChildOnMessage = cb.onMessage;
        const handle = {
          startedAt: Date.now(),
          pid,
          alive: true,
          cachedInit: null as unknown,
          setCachedInit(init: unknown): void {
            handle.cachedInit = init;
          },
          send(payload: unknown): void {
            writes.push(payload);
            const p = payload as { id?: number; method?: string };
            // Fresh (post-fork) children auto-respond to initialize/subscribe.
            if (!isFirst && typeof p.id === "number" && p.id < 0) {
              setTimeout(() => {
                if (p.method === "initialize") {
                  cb.onMessage({
                    jsonrpc: "2.0",
                    id: p.id,
                    result: {
                      protocolVersion: "2025-06-18",
                      serverInfo: { name: "stub", version: "1" },
                      capabilities: {},
                    },
                  });
                } else if (p.method === "resources/subscribe") {
                  cb.onMessage({ jsonrpc: "2.0", id: p.id, result: {} });
                }
              }, 5);
            }
            // Old child does NOT auto-respond to bridge tools/list; the test will manually.
          },
          async kill(): Promise<void> {},
        };
        return handle as never;
      },
    });
    await manager.start();

    const c1 = freshClient(paths);
    const c2 = freshClient(paths);
    try {
      await c1.connect();
      await c2.connect();
      const sid1 = "11111111-1111-1111-1111-111111111111";
      const sid2 = "22222222-2222-2222-2222-222222222222";

      const c2Replies: unknown[] = [];
      c2.setNotificationHandler((n) => {
        if (n.method === "RPC") c2Replies.push((n.params as { payload: unknown }).payload);
      });

      await c1.call("OPEN", { sessionId: sid1, spec: defaultSpec("auto") });
      await c2.call("OPEN", { sessionId: sid2, spec: defaultSpec("auto") });

      // sid2 sends an inflight tools/list via RPC notification.
      c2.sendNotification("RPC", {
        sessionId: sid2,
        payload: { jsonrpc: "2.0", id: 42, method: "tools/list", params: {} },
      });
      await new Promise((r) => setTimeout(r, 30));

      // Inflight should be tracked on old child.
      const oldChildWrites = writesByPid.get(3000)!;
      const inflightRequest = oldChildWrites.find(
        (w) => (w as { method?: string }).method === "tools/list",
      ) as { id: number };
      expect(inflightRequest).toBeDefined();
      expect(typeof inflightRequest.id).toBe("number");
      expect(inflightRequest.id).toBeGreaterThan(0);

      // Trigger fork.
      manager.spawnedChildEmitForTest({
        jsonrpc: "2.0",
        id: 200,
        method: "sampling/createMessage",
        params: {},
      });
      await new Promise((r) => setTimeout(r, 100));

      // Migration should still be in draining (replay done but inflight non-zero).
      // Verify by attempting to send more outbound from sid2 — it should buffer.
      c2.sendNotification("RPC", {
        sessionId: sid2,
        payload: { jsonrpc: "2.0", id: 43, method: "prompts/list", params: {} },
      });
      await new Promise((r) => setTimeout(r, 30));
      // At this point, prompts/list should NOT have reached either child yet.
      const allOldWrites = writesByPid.get(3000)!.filter(
        (w) => (w as { method?: string }).method === "prompts/list",
      );
      const newChildPid = Array.from(writesByPid.keys()).find((p) => p !== 3000);
      const allNewWrites =
        newChildPid !== undefined
          ? (writesByPid.get(newChildPid) ?? []).filter(
              (w) => (w as { method?: string }).method === "prompts/list",
            )
          : [];
      expect(allOldWrites).toEqual([]);
      expect(allNewWrites).toEqual([]);

      // Now simulate old child responding to tools/list.
      oldChildOnMessage!({
        jsonrpc: "2.0",
        id: inflightRequest.id,
        result: { tools: [] },
      });
      await new Promise((r) => setTimeout(r, 100));

      // Migration should now have completed; queued prompts/list should reach new child.
      expect(newChildPid).toBeDefined();
      const newWritesAfter = writesByPid.get(newChildPid!)!.filter(
        (w) => (w as { method?: string }).method === "prompts/list",
      );
      expect(newWritesAfter.length).toBe(1);
    } finally {
      c1.close();
      c2.close();
    }
  });
});

describe.skipIf(isWindows)("AutoForkOrchestrator — drain timeout + SESSION_EVICTED (Phase D)", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });
  afterEach(async () => {
    if (manager !== null) await manager.stop(0).catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  it("drain timeout with replay done: synth -32002 for stuck inflight + completes migration", async () => {
    let nextPid = 4000;
    const writesByPid = new Map<number, unknown[]>();
    let firstChild = true;

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      autoForkDrainTimeoutMs: 100, // short so the test runs fast
      autoForkInitializeTimeoutMs: 5_000,
      _spawnChild: (_spec, cb) => {
        const isFirst = firstChild;
        firstChild = false;
        const pid = nextPid++;
        const writes: unknown[] = [];
        writesByPid.set(pid, writes);
        const handle = {
          startedAt: Date.now(),
          pid,
          alive: true,
          cachedInit: null as unknown,
          setCachedInit(init: unknown): void { handle.cachedInit = init; },
          send(payload: unknown): void {
            writes.push(payload);
            const p = payload as { id?: number; method?: string };
            // New (post-fork) children auto-respond to internal initialize/subscribe.
            if (!isFirst && typeof p.id === "number" && p.id < 0) {
              setTimeout(() => {
                if (p.method === "initialize") {
                  cb.onMessage({
                    jsonrpc: "2.0", id: p.id,
                    result: { protocolVersion: "2025-06-18", serverInfo: { name: "stub", version: "1" }, capabilities: {} },
                  });
                } else if (p.method === "resources/subscribe") {
                  cb.onMessage({ jsonrpc: "2.0", id: p.id, result: {} });
                }
              }, 5);
            }
            // Old child does NOT respond to its inflight (stuck).
          },
          async kill(): Promise<void> {},
        };
        return handle as never;
      },
    });
    await manager.start();

    const c1 = freshClient(paths);
    const c2 = freshClient(paths);
    try {
      await c1.connect();
      await c2.connect();
      const sid1 = "11111111-1111-1111-1111-111111111111";
      const sid2 = "22222222-2222-2222-2222-222222222222";
      const c2Errors: Array<{ id: unknown; error: { code: number } }> = [];
      c2.setNotificationHandler((n) => {
        if (n.method !== "RPC") return;
        const payload = (n.params as { payload: { id?: unknown; error?: { code: number } } }).payload;
        if (payload.error !== undefined) c2Errors.push({ id: payload.id, error: payload.error });
      });

      await c1.call("OPEN", { sessionId: sid1, spec: defaultSpec("auto") });
      await c2.call("OPEN", { sessionId: sid2, spec: defaultSpec("auto") });

      // sid2 sends a tools/list that the old child never answers.
      c2.sendNotification("RPC", {
        sessionId: sid2,
        payload: { jsonrpc: "2.0", id: 42, method: "tools/list", params: {} },
      });
      await new Promise((r) => setTimeout(r, 30));

      // Trigger fork.
      manager.spawnedChildEmitForTest({
        jsonrpc: "2.0", id: 100, method: "sampling/createMessage", params: {},
      });

      // Wait for replay to finish + drain timeout to fire (100ms + replay ~10ms slack).
      await new Promise((r) => setTimeout(r, 250));

      // Bridge B should have received DRAIN_TIMEOUT for id=42.
      const drainErrors = c2Errors.filter((e) => e.error.code === -32002);
      expect(drainErrors).toHaveLength(1);
      expect(drainErrors[0]!.id).toBe(42);

      // Migration should have completed despite the stuck inflight.
      // Submitting a new RPC should now hit the new child directly (not buffered).
      const newChildPid = Array.from(writesByPid.keys()).find((p) => p !== 4000);
      expect(newChildPid).toBeDefined();
      const newChildWritesBefore = writesByPid.get(newChildPid!)!.filter((w) => (w as { method?: string }).method === "prompts/list").length;
      c2.sendNotification("RPC", {
        sessionId: sid2,
        payload: { jsonrpc: "2.0", id: 99, method: "prompts/list", params: {} },
      });
      await new Promise((r) => setTimeout(r, 30));
      const newChildWritesAfter = writesByPid.get(newChildPid!)!.filter((w) => (w as { method?: string }).method === "prompts/list").length;
      expect(newChildWritesAfter).toBe(newChildWritesBefore + 1);
    } finally {
      c1.close();
      c2.close();
    }
  });

  it("drain timeout with replay incomplete: emits SESSION_EVICTED auto_fork_drain_timeout", async () => {
    let nextPid = 5000;
    let firstChild = true;

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      autoForkDrainTimeoutMs: 100,
      autoForkInitializeTimeoutMs: 10_000, // larger than drain timeout
      _spawnChild: (_spec, cb) => {
        const isFirst = firstChild;
        firstChild = false;
        const pid = nextPid++;
        const handle = {
          startedAt: Date.now(),
          pid,
          alive: true,
          cachedInit: null as unknown,
          setCachedInit(init: unknown): void { handle.cachedInit = init; },
          send(payload: unknown): void {
            // New child does NOT respond to initialize -> replay never completes.
            void payload;
            void cb;
            void isFirst;
          },
          async kill(): Promise<void> {},
        };
        return handle as never;
      },
    });
    await manager.start();

    const c1 = freshClient(paths);
    const c2 = freshClient(paths);
    try {
      await c1.connect();
      await c2.connect();
      const sid1 = "11111111-1111-1111-1111-111111111111";
      const sid2 = "22222222-2222-2222-2222-222222222222";
      const c2Notifs: Array<{ method: string; params: unknown }> = [];
      c2.setNotificationHandler((n) => {
        if (n.method === "SESSION_EVICTED") c2Notifs.push({ method: n.method, params: n.params });
      });

      await c1.call("OPEN", { sessionId: sid1, spec: defaultSpec("auto") });
      await c2.call("OPEN", { sessionId: sid2, spec: defaultSpec("auto") });

      // Trigger fork; replay will stall (new child never responds).
      manager.spawnedChildEmitForTest({
        jsonrpc: "2.0", id: 100, method: "sampling/createMessage", params: {},
      });

      // Wait > drain timeout.
      await new Promise((r) => setTimeout(r, 200));

      // Bridge B should have received SESSION_EVICTED with reason auto_fork_drain_timeout.
      expect(c2Notifs).toHaveLength(1);
      expect(c2Notifs[0]!.method).toBe("SESSION_EVICTED");
      const params = c2Notifs[0]!.params as { sessionId: string; reason: string };
      expect(params.sessionId).toBe(sid2);
      expect(params.reason).toBe("auto_fork_drain_timeout");
    } finally {
      c1.close();
      c2.close();
    }
  });
});

describe.skipIf(isWindows)("AutoForkOrchestrator — hash taint persistence (Phase D)", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });
  afterEach(async () => {
    if (manager !== null) await manager.stop(0).catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  it("post-fork OPEN with sharing=auto for same hash spawns fresh dedicated child; STATUS reflects all groups", async () => {
    let nextPid = 7000;
    let firstChild = true;

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: (_spec, cb) => {
        const isFirst = firstChild;
        firstChild = false;
        const pid = nextPid++;
        const handle = {
          startedAt: Date.now(),
          pid,
          alive: true,
          cachedInit: null as unknown,
          setCachedInit(init: unknown): void {
            handle.cachedInit = init;
          },
          send(payload: unknown): void {
            const p = payload as { id?: number; method?: string };
            // Post-fork children auto-respond to internal init/subscribe.
            if (!isFirst && typeof p.id === "number" && p.id < 0) {
              setTimeout(() => {
                if (p.method === "initialize") {
                  cb.onMessage({
                    jsonrpc: "2.0",
                    id: p.id,
                    result: {
                      protocolVersion: "2025-06-18",
                      serverInfo: { name: "stub", version: "1" },
                      capabilities: {},
                    },
                  });
                } else if (p.method === "resources/subscribe") {
                  cb.onMessage({ jsonrpc: "2.0", id: p.id, result: {} });
                }
              }, 5);
            }
          },
          async kill(): Promise<void> {},
        };
        return handle as never;
      },
    });
    await manager.start();

    const c1 = freshClient(paths);
    const c2 = freshClient(paths);
    const c3 = freshClient(paths);
    try {
      await c1.connect();
      await c2.connect();
      await c3.connect();

      const sid1 = "11111111-1111-1111-1111-111111111111";
      const sid2 = "22222222-2222-2222-2222-222222222222";
      const sid3 = "33333333-3333-3333-3333-333333333333";

      // Two auto OPENs to set up the shared child.
      await c1.call("OPEN", { sessionId: sid1, spec: defaultSpec("auto") });
      await c2.call("OPEN", { sessionId: sid2, spec: defaultSpec("auto") });

      const status0 = (await c1.call("STATUS")) as {
        children: Array<{ refcount: number; mode: string; sharing: string; forked: boolean; pid: number }>;
      };
      expect(status0.children).toHaveLength(1);
      const oldChildPid = status0.children[0]!.pid;

      // Trigger fork.
      manager.spawnedChildEmitForTest({
        jsonrpc: "2.0",
        id: 100,
        method: "sampling/createMessage",
        params: {},
      });

      // Wait for replay to finish.
      await new Promise((r) => setTimeout(r, 100));

      // Now open a third session with sharing=auto, same spec/hash.
      // Expect a fresh dedicated child, NOT attached to either existing group.
      await c3.call("OPEN", { sessionId: sid3, spec: defaultSpec("auto") });

      const status1 = (await c3.call("STATUS")) as {
        children: Array<{
          pid: number;
          refcount: number;
          mode: string;
          sharing: string;
          forked: boolean;
          sessions: string[];
        }>;
      };

      // Expect 3 children:
      //   - old child: mode=dedicated, forked=true, sharing=auto, sessions=[sid1]
      //   - fork child for sid2: mode=dedicated, forked=false, sharing=auto, sessions=[sid2]
      //   - new dedicated child for sid3 (post-taint): mode=dedicated, forked=false, sharing=auto, sessions=[sid3]
      expect(status1.children.length).toBe(3);

      const oldChild = status1.children.find((c) => c.pid === oldChildPid);
      expect(oldChild).toBeDefined();
      expect(oldChild!.mode).toBe("dedicated");
      expect(oldChild!.sharing).toBe("auto");
      expect(oldChild!.forked).toBe(true);
      expect(oldChild!.sessions).toEqual([sid1]);

      const sid2Child = status1.children.find((c) => c.sessions.includes(sid2));
      expect(sid2Child).toBeDefined();
      expect(sid2Child!.mode).toBe("dedicated");
      expect(sid2Child!.sharing).toBe("auto");
      expect(sid2Child!.forked).toBe(false);

      const sid3Child = status1.children.find((c) => c.sessions.includes(sid3));
      expect(sid3Child).toBeDefined();
      expect(sid3Child!.mode).toBe("dedicated");
      expect(sid3Child!.sharing).toBe("auto");
      expect(sid3Child!.forked).toBe(false);
      expect(sid3Child!.pid).not.toBe(oldChildPid);
      expect(sid3Child!.pid).not.toBe(sid2Child!.pid);
    } finally {
      c1.close();
      c2.close();
      c3.close();
    }
  });
});

describe.skipIf(isWindows)("AutoForkOrchestrator — edge cases (Phase D)", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });
  afterEach(async () => {
    if (manager !== null) await manager.stop(0).catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  it("old child dies mid-fork: draining sessions still complete migration", async () => {
    // Setup: two auto OPENs (sid1 + sid2), trigger fork, then kill old child
    // before its inflight responses arrive. The new child for sid2 still
    // initializes successfully; migration should complete (no stuck inflight
    // because the rewriter detach happens via handleChildExit's detach flow,
    // and our draining branch in detachSession handles cleanup).
    let nextPid = 8000;
    let firstChild = true;
    let oldChildOnClose: (() => void) | null = null;

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      autoForkDrainTimeoutMs: 5_000, // generous so we don't hit the timeout
      _spawnChild: (_spec, cb) => {
        const isFirst = firstChild;
        firstChild = false;
        const pid = nextPid++;
        if (isFirst) oldChildOnClose = cb.onClose;
        const handle = {
          startedAt: Date.now(),
          pid,
          alive: true,
          cachedInit: null as unknown,
          setCachedInit(init: unknown): void { handle.cachedInit = init; },
          send(payload: unknown): void {
            const p = payload as { id?: number; method?: string };
            if (!isFirst && typeof p.id === "number" && p.id < 0) {
              setTimeout(() => {
                if (p.method === "initialize") {
                  cb.onMessage({
                    jsonrpc: "2.0", id: p.id,
                    result: {
                      protocolVersion: "2025-06-18",
                      serverInfo: { name: "stub", version: "1" },
                      capabilities: {},
                    },
                  });
                } else if (p.method === "resources/subscribe") {
                  cb.onMessage({ jsonrpc: "2.0", id: p.id, result: {} });
                }
              }, 5);
            }
          },
          async kill(): Promise<void> {},
        };
        return handle as never;
      },
    });
    await manager.start();

    const c1 = freshClient(paths);
    const c2 = freshClient(paths);
    try {
      await c1.connect();
      await c2.connect();
      const sid1 = "11111111-1111-1111-1111-111111111111";
      const sid2 = "22222222-2222-2222-2222-222222222222";
      await c1.call("OPEN", { sessionId: sid1, spec: defaultSpec("auto") });
      await c2.call("OPEN", { sessionId: sid2, spec: defaultSpec("auto") });

      // Trigger fork.
      manager.spawnedChildEmitForTest({
        jsonrpc: "2.0", id: 100, method: "sampling/createMessage", params: {},
      });

      // Wait briefly so migration starts.
      await new Promise((r) => setTimeout(r, 50));

      // Kill the old child.
      expect(oldChildOnClose).not.toBeNull();
      oldChildOnClose!();

      // Wait for cleanup.
      await new Promise((r) => setTimeout(r, 100));

      // STATUS: sid2 should be on its new dedicated child.
      // sid1 (originating) was on the old child, which just died — so sid1's
      // session should also be detached (handleChildExit cleanup).
      const status = (await c2.call("STATUS")) as {
        children: Array<{ pid: number; sessions: string[]; mode: string }>;
        sessions: Array<{ sessionId: string }>;
      };

      // sid1 detached when old child died.
      expect(status.sessions.find((s) => s.sessionId === sid1)).toBeUndefined();
      // sid2 still attached to its new child.
      const sid2Child = status.children.find((c) => c.sessions.includes(sid2));
      expect(sid2Child).toBeDefined();
      expect(sid2Child!.mode).toBe("dedicated");
    } finally {
      c1.close();
      c2.close();
    }
  });

  it("bridge channel drops during drain: new child cleaned up; no leaked group", async () => {
    let nextPid = 9000;
    const childKilledByPid = new Map<number, boolean>();

    manager = new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      autoForkDrainTimeoutMs: 5_000,
      _spawnChild: (_spec, cb) => {
        const pid = nextPid++;
        const handle = {
          startedAt: Date.now(),
          pid,
          alive: true,
          cachedInit: null as unknown,
          setCachedInit(init: unknown): void { handle.cachedInit = init; },
          send(payload: unknown): void {
            const p = payload as { id?: number; method?: string };
            // New child stalls on initialize so the session stays in draining.
            void p; void cb;
          },
          async kill(): Promise<void> {
            childKilledByPid.set(pid, true);
          },
        };
        return handle as never;
      },
    });
    await manager.start();

    const c1 = freshClient(paths);
    const c2 = freshClient(paths);
    try {
      await c1.connect();
      await c2.connect();
      const sid1 = "11111111-1111-1111-1111-111111111111";
      const sid2 = "22222222-2222-2222-2222-222222222222";
      await c1.call("OPEN", { sessionId: sid1, spec: defaultSpec("auto") });
      await c2.call("OPEN", { sessionId: sid2, spec: defaultSpec("auto") });

      // Trigger fork. sid2's new child stalls on initialize → sid2 stays draining.
      manager.spawnedChildEmitForTest({
        jsonrpc: "2.0", id: 100, method: "sampling/createMessage", params: {},
      });
      await new Promise((r) => setTimeout(r, 50));

      // Snapshot the new child PID before c2 closes.
      const status0 = (await c1.call("STATUS")) as {
        children: Array<{ pid: number; sessions: string[] }>;
      };
      const newChildEntry = status0.children.find((c) => c.sessions.includes(sid2));
      expect(newChildEntry).toBeDefined();
      const newChildPid = newChildEntry!.pid;

      // Drop bridge channel for c2.
      c2.close();

      // Wait for cleanup.
      await new Promise((r) => setTimeout(r, 100));

      // sid2 is detached.
      const status1 = (await c1.call("STATUS")) as {
        sessions: Array<{ sessionId: string }>;
        children: Array<{ pid: number; sessions: string[] }>;
      };
      expect(status1.sessions.find((s) => s.sessionId === sid2)).toBeUndefined();

      // The new child was killed (no other sessions on it).
      // Either it's no longer in the children list, or the kill() helper got called.
      const newChildStill = status1.children.find((c) => c.pid === newChildPid);
      const wasKilled = childKilledByPid.get(newChildPid) === true;
      expect(newChildStill === undefined || wasKilled).toBe(true);
    } finally {
      c1.close();
      try { c2.close(); } catch { /* may already be closed */ }
    }
  });
});
