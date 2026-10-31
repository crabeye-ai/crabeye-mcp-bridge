import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { BridgeConfigSchema } from "../../src/config/schema.js";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import { DAEMON_CONNECTION_CLOSED } from "../../src/daemon/client.js";
import { ManagerDaemon, type ManagerOptions } from "../../src/daemon/manager.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { encodeFrame, FrameDecoder, type StatusResult, type UpstreamSnapshot } from "../../src/daemon/protocol.js";
import { getBridgeConfigPath } from "../../src/config/bridge-config.js";
import { InstanceLink, instanceSourceFor, type UpstreamView } from "../../src/upstream/instance-link.js";
import { spawnTestManager, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import { ScriptedUpstreamClient } from "../_helpers/scripted-upstream-client.js";
import { recordingLogger, type LoggedLine } from "../_helpers/spy-logger.js";
import type { Logger } from "../../src/logging/index.js";

function recordingView(): UpstreamView & { events: string[]; snapshots: UpstreamSnapshot[] } {
  const events: string[] = [];
  const snapshots: UpstreamSnapshot[] = [];
  return {
    events,
    snapshots,
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot);
      events.push(`snapshot:${snapshot.status}`);
    },
    onRemoved: () => events.push("removed"),
    onInterrupted: () => events.push("interrupted"),
    onDown: (error) => events.push(`down:${error.message}`),
  };
}

const SOURCE = { kind: "file" as const, path: "/home/u/bridge.json" };
const TIMINGS = { rpcTimeoutMs: 30_000, heartbeatMs: 60_000, respawnLockWaitMs: 60_000 };

describe.skipIf(process.platform === "win32")("InstanceLink", { timeout: 30_000 }, () => {
  let fx: DaemonFixture;
  let servers: Record<string, unknown>;
  let clients: ScriptedUpstreamClient[];
  let clientLogs: Map<string, Logger>;
  let loadError: Error | undefined;
  let replacement: ManagerDaemon | undefined;
  let lines: LoggedLine[];
  const links: InstanceLink[] = [];

  function instances(): ManagerOptions["_instances"] {
    return {
      loadConfig: async () => {
        if (loadError) throw loadError;
        return { config: BridgeConfigSchema.parse({ mcpServers: servers }), watchPaths: [] };
      },
      createCredentialStore: () => ({}) as CredentialStore,
      createHttpClient: (name, _config, { logger }) => {
        const client = new ScriptedUpstreamClient(name);
        clients.push(client);
        clientLogs.set(name, logger);
        return client;
      },
    };
  }

  function link(overrides: Partial<ConstructorParameters<typeof InstanceLink>[0]> = {}): InstanceLink {
    const created = new InstanceLink({
      source: SOURCE,
      env: {},
      childEnv: {},
      logger: recordingLogger(lines),
      ...TIMINGS,
      _socketPath: fx.socketPath,
      _ensureDaemon: async () => {},
      ...overrides,
    });
    links.push(created);
    return created;
  }

  async function status(): Promise<StatusResult> {
    return (await fx.client.call("STATUS")) as StatusResult;
  }

  function startReplacement(): Promise<void> {
    replacement = new ManagerDaemon({
      socketPath: fx.socketPath,
      pidPath: fx.pidPath,
      lockPath: fx.lockPath,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: join(fx.dir, "processes.json"),
      _instances: instances(),
    });
    return replacement.start();
  }

  beforeEach(async () => {
    servers = { svc: { url: "https://svc.example.com/mcp" }, other: { url: "https://other.example.com/mcp" } };
    clients = [];
    clientLogs = new Map();
    loadError = undefined;
    lines = [];
    fx = await spawnTestManager({ manager: { _instances: instances() } });
  });

  afterEach(async () => {
    await Promise.all(links.splice(0).map((l) => l.close()));
    await replacement?.stop(0).catch(() => {});
    replacement = undefined;
    await fx.stop();
  });

  it("attaches once however many stand-ins ask, and keeps the snapshots the daemon sends", async () => {
    const l = link();
    const view = recordingView();
    l.watch("svc", view);

    await Promise.all([l.attach(), l.attach(), l.attach()]);

    expect(l.isAttached).toBe(true);
    expect((await status()).instances).toEqual([{ source: SOURCE, bridges: 1, upstreams: ["other", "svc"] }]);
    expect(l.snapshot("svc")).toMatchObject({ name: "svc", status: "connected" });
    expect(view.events).toEqual(["snapshot:connected"]);
  });

  it("tells stand-ins about the snapshots it gets while attaching only once attached, so a call made then can go through", async () => {
    const l = link();
    const attachedWhenTold: boolean[] = [];
    l.watch("svc", {
      ...recordingView(),
      onSnapshot: () => {
        attachedWhenTold.push(l.isAttached);
        void l.callTool("svc", { name: "search" }).catch(() => {});
      },
    });

    await l.attach();

    expect(attachedWhenTold).toEqual([true]);
    await vi.waitFor(() => expect(clients.find((c) => c.name === "svc")!.calls).toHaveLength(1));
  });

  it("retries an upstream and calls its tools", async () => {
    const l = link();
    await l.attach();
    const svc = clients.find((c) => c.name === "svc")!;
    svc.setStatus("disconnected", new Error("reset"));

    expect(await l.retry("svc")).toMatchObject({ status: "connected" });
    expect(await l.callTool("svc", { name: "search", arguments: { q: "x" } })).toEqual({ content: [{ type: "text", text: "called search" }] });
    expect(svc.calls).toMatchObject([{ name: "search", arguments: { q: "x" } }]);
    await expect(l.retry("nope")).rejects.toThrow('"nope" is not in the configuration the manager loaded');
  });

  it("cancels a call upstream and rejects it at once when the caller aborts", async () => {
    const l = link();
    await l.attach();
    const svc = clients.find((c) => c.name === "svc")!;
    let upstreamAborted = false;
    svc.answer = (call) =>
      new Promise((_, reject) =>
        call.signal!.addEventListener("abort", () => {
          upstreamAborted = true;
          reject(new Error("aborted"));
        }),
      );
    const controller = new AbortController();
    const call = l.callTool("svc", { name: "slow" }, controller.signal);
    await vi.waitFor(() => expect(svc.calls).toHaveLength(1));

    controller.abort(new Error("Request cancelled"));

    await expect(call).rejects.toThrow("Request cancelled");
    await vi.waitFor(() => expect(upstreamAborted).toBe(true));
    await expect(l.callTool("svc", { name: "slow" }, controller.signal)).rejects.toThrow("Request cancelled");
    expect(svc.calls).toHaveLength(1);
  });

  it("writes the daemon's warnings about an upstream to the bridge log, with the server name", async () => {
    const l = link();
    await l.attach();

    clientLogs.get("svc")!.warn("ping failed", { component: "health", error: "timeout", failures: 2 });
    clientLogs.get("svc")!.error("token refresh failed");

    await vi.waitFor(() =>
      expect(lines).toEqual([
        { level: "warn", message: "ping failed", context: { component: "health", server: "svc", error: "timeout", failures: 2 } },
        { level: "error", message: "token refresh failed", context: { component: "upstream", server: "svc" } },
      ]),
    );
  });

  it("fails calls in flight with the daemon error when the daemon goes away, then attaches to its replacement", async () => {
    let replaced = false;
    const l = link({
      _ensureDaemon: async (opts) => {
        if (opts?.freshAttempt && !replaced) {
          replaced = true;
          await startReplacement();
        }
      },
    });
    const view = recordingView();
    l.watch("svc", view);
    await l.attach();
    clients[0]!.answer = () => new Promise(() => {});
    const inFlight = expect(l.callTool("svc", { name: "slow" })).rejects.toThrow(DAEMON_CONNECTION_CLOSED);

    await fx.kill();

    await inFlight;
    await vi.waitFor(() => expect(l.isAttached).toBe(true));
    expect(view.events).toEqual(["snapshot:connected", "interrupted", "snapshot:connected"]);
    expect(clients).toHaveLength(4);
    expect(await l.callTool("svc", { name: "search" })).toEqual({ content: [{ type: "text", text: "called search" }] });
  });

  it("tells stand-ins whose upstream the replacement daemon doesn't have, also for a server no daemon had", async () => {
    const l = link({ _ensureDaemon: async (opts) => (opts?.freshAttempt ? startReplacement() : undefined) });
    const [view, ghost] = [recordingView(), recordingView()];
    l.watch("other", view);
    l.watch("ghost", ghost);
    await l.attach();
    expect(ghost.events).toEqual(["removed"]);
    servers = { svc: { url: "https://svc.example.com/mcp" } };

    await fx.kill();

    await vi.waitFor(() => expect(view.events.at(-1)).toBe("removed"));
    expect(l.snapshot("other")).toBeUndefined();
    expect(ghost.events).toEqual(["removed", "interrupted", "removed"]);
  });

  it("waits past the RPC timeout for a tool call and for a retry", async () => {
    const l = link({ rpcTimeoutMs: 50 });
    await l.attach();
    const svc = clients.find((c) => c.name === "svc")!;
    svc.answer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { content: [] };
    };

    await expect(l.callTool("svc", { name: "slow" })).resolves.toEqual({ content: [] });
    svc.setStatus("disconnected");
    svc.attempt = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      svc.setStatus("connected");
    };
    await expect(l.retry("svc")).resolves.toMatchObject({ status: "connected" });
  });

  it("reports the daemon error when it can't attach, then retries with backoff", async () => {
    loadError = new Error("boom");
    const l = link({ reconnect: { reconnectBaseDelay: 100, reconnectMaxDelay: 200 } });
    const view = recordingView();
    l.watch("svc", view);

    await expect(l.attach()).rejects.toThrow("boom");
    expect(view.events).toEqual(["down:boom"]);
    await expect(l.attachNow()).rejects.toThrow("boom");

    loadError = undefined;
    await vi.waitFor(() => expect(l.isAttached).toBe(true), { timeout: 2_000 });
    expect(view.events.at(-1)).toBe("snapshot:connected");
  });

  it("reports a failed respawn to stand-ins and keeps trying", async () => {
    let attempts = 0;
    const l = link({
      reconnect: { reconnectBaseDelay: 100, reconnectMaxDelay: 200 },
      respawnLockWaitMs: 100,
      _ensureDaemon: async (opts) => {
        if (!opts?.freshAttempt && attempts === 0) return;
        attempts++;
        if (attempts === 1) throw new Error("daemon did not become reachable within timeout");
        await startReplacement();
      },
    });
    const view = recordingView();
    l.watch("svc", view);
    await l.attach();

    await fx.kill();

    await vi.waitFor(() => expect(view.events).toContain("down:daemon did not become reachable within timeout"));
    await vi.waitFor(() => expect(l.isAttached).toBe(true), { timeout: 5_000 });
    expect(view.events.at(-1)).toBe("snapshot:connected");
  });

  it("detaches from the instance when closed, failing calls still in flight", async () => {
    const l = link();
    await l.attach();
    clients[0]!.answer = () => new Promise(() => {});
    const inFlight = expect(l.callTool("svc", { name: "slow" })).rejects.toThrow(DAEMON_CONNECTION_CLOSED);

    await l.close();

    await inFlight;
    await vi.waitFor(async () => expect((await status()).instances).toEqual([{ source: SOURCE, bridges: 0, upstreams: ["other", "svc"] }]));
    await expect(l.attach()).rejects.toThrow("closed");
    await expect(l.callTool("svc", { name: "x" })).rejects.toThrow(DAEMON_CONNECTION_CLOSED);
  });

  it("doesn't attach again when asked to right after a failed attempt, and backs off longer after each failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const attempts: number[] = [];
      const l = link({
        reconnect: { reconnectBaseDelay: 100, reconnectMaxDelay: 400 },
        _ensureDaemon: async () => {
          attempts.push(Date.now());
          throw new Error("daemon unreachable");
        },
      });
      l.watch("svc", recordingView());
      const start = Date.now();

      await expect(l.attach()).rejects.toThrow("daemon unreachable");
      await expect(l.attachNow()).rejects.toThrow("daemon unreachable");
      expect(attempts).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(100 + 200 + 400 + 400);

      expect(attempts.map((at) => at - start)).toEqual([0, 100, 300, 700, 1_100]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(process.platform === "win32")("InstanceLink.retry against a daemon that answers in one write", () => {
  let dir: string;
  let server: Server;
  let retryAnswer: (id: string) => Buffer;
  let link: InstanceLink;
  let socketPath: string;
  let attaches: Array<Record<string, unknown>>;
  let onAttach: Buffer[];

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-retry-");
    socketPath = join(dir, "d.sock");
    attaches = [];
    onAttach = [];
    server = createServer((sock: Socket) => {
      const decoder = new FrameDecoder();
      sock.on("data", (chunk: Buffer) => {
        decoder.push(chunk);
        for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
          const request = frame as { id: string; method: string; params: Record<string, unknown> };
          if (request.method === "ATTACH") {
            attaches.push(request.params);
            for (const extra of onAttach) sock.write(extra);
            sock.write(encodeFrame({ method: "UPSTREAM", params: { name: "svc", status: "disconnected", tools: [] } }));
            sock.write(encodeFrame({ id: request.id, result: { upstreams: ["svc"] } }));
          } else if (request.method === "RETRY") {
            sock.write(retryAnswer(request.id));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    link = new InstanceLink({ source: SOURCE, env: {}, childEnv: {}, ...TIMINGS, _socketPath: socketPath, _ensureDaemon: async () => {} });
  });

  afterEach(async () => {
    await link.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps a snapshot that arrived right after the reply instead of the reply", async () => {
    retryAnswer = (id) =>
      Buffer.concat([
        encodeFrame({ method: "UPSTREAM", params: { name: "svc", status: "connected", tools: [] } }),
        encodeFrame({ id, result: { name: "svc", status: "connected", tools: [] } }),
        encodeFrame({ method: "UPSTREAM", params: { name: "svc", status: "disconnected", error: "reset", tools: [] } }),
      ]);
    await link.attach();

    expect(await link.retry("svc")).toMatchObject({ status: "disconnected", error: "reset" });
    expect(link.snapshot("svc")).toMatchObject({ status: "disconnected" });
  });

  it("rejects a reply that isn't a snapshot", async () => {
    retryAnswer = (id) => encodeFrame({ id, result: { name: "svc", status: "connected" } });
    await link.attach();

    await expect(link.retry("svc")).rejects.toThrow('malformed RETRY reply for "svc"');
  });

  it("reads a status it doesn't know as disconnected instead of keeping the last one", async () => {
    retryAnswer = (id) =>
      Buffer.concat([
        encodeFrame({ method: "UPSTREAM", params: { name: "svc", status: "sleeping", tools: [] } }),
        encodeFrame({ id, result: { name: "svc", status: "sleeping", tools: [] } }),
      ]);
    await link.attach();

    expect(await link.retry("svc")).toEqual({
      name: "svc",
      status: "disconnected",
      error: "the manager reported a status this bridge doesn't know: sleeping",
      tools: [],
    });
  });

  it("sends the environment it was given for the STDIO servers the instance starts when it attaches", async () => {
    const withEnv = new InstanceLink({ source: SOURCE, env: {}, childEnv: { PATH: "/usr/bin", MARKER: "m" }, ...TIMINGS, _socketPath: socketPath, _ensureDaemon: async () => {} });
    try {
      await withEnv.attach();
    } finally {
      await withEnv.close();
    }

    expect(attaches.at(-1)).toMatchObject({ env: {}, childEnv: { PATH: "/usr/bin", MARKER: "m" } });
  });

  it("logs a line at a level it doesn't know at debug, and a stopped server's stderr lines with it", async () => {
    const lines: LoggedLine[] = [];
    onAttach = [
      encodeFrame({ method: "LOG", params: { upstream: "svc", level: "trace", message: "from a newer manager" } }),
      encodeFrame({ method: "LOG", params: { upstream: "svc", level: "warn", message: "STDIO server exited with code 1", stderr: ["boom"] } }),
      encodeFrame({ method: "LOG", params: { upstream: "svc", level: "warn", message: "bad stderr", stderr: "boom" } }),
    ];
    const logged = new InstanceLink({ source: SOURCE, env: {}, childEnv: {}, logger: recordingLogger(lines), ...TIMINGS, _socketPath: socketPath, _ensureDaemon: async () => {} });
    try {
      await logged.attach();
    } finally {
      await logged.close();
    }

    expect(lines).toEqual([
      { level: "debug", message: "from a newer manager", context: { component: "upstream", server: "svc" } },
      { level: "warn", message: "STDIO server exited with code 1", context: { component: "upstream", server: "svc", stderr: ["boom"] } },
    ]);
  });
});

describe("instanceSourceFor", () => {
  it("names an explicit config by its absolute path, and the default by the bridge-owned config.json", () => {
    expect(instanceSourceFor("conf/bridge.json")).toEqual({ kind: "file", path: join(process.cwd(), "conf/bridge.json") });
    expect(instanceSourceFor(undefined)).toEqual({ kind: "merged", path: getBridgeConfigPath() });
  });
});
