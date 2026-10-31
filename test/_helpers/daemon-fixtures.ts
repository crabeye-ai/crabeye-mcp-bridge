/**
 * Test-only helpers for spinning up a real `ManagerDaemon` on a temp socket,
 * and attaching bridges to its instances.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { BridgeConfigSchema } from "../../src/config/schema.js";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { ManagerDaemon, type ManagerOptions } from "../../src/daemon/manager.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import {
  MIN_BRIDGE_PROTOCOL_VERSION,
  type DaemonNotification,
  type InstanceSource,
  type UpstreamLogParams,
  type UpstreamSnapshot,
} from "../../src/daemon/protocol.js";
import { STUB_STDIO_SERVER } from "./stub-stdio-server.js";

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 20));
  }
}

export interface SpawnTestManagerOpts {
  /** Override idleMs (default 60_000). */
  idleMs?: number;
  manager?: Partial<ManagerOptions>;
}

export interface DaemonFixture {
  dir: string;
  socketPath: string;
  pidPath: string;
  lockPath: string;
  client: DaemonClient;
  manager: ManagerDaemon;
  /**
   * Drop the manager process. Subsequent client RPCs see a closed socket.
   * Resolves once the daemon's exit promise resolves.
   */
  kill(): Promise<void>;
  /**
   * Replace the daemon side's inbound-message handler with a no-op so the
   * socket stays open but no frames are processed. Used to simulate a
   * stalled daemon.
   */
  severIncomingFrames(): void;
  /** Overwrite the pidfile with an arbitrary pid. Test-only. */
  writePidfile(pid: number): Promise<void>;
  /** Tear down: stop manager, close client, remove temp dir. */
  stop(): Promise<void>;
}

async function tempPaths(): Promise<{ dir: string; sock: string; pid: string; lock: string }> {
  // macOS UDS sun_path cap (104B) is shorter than the default $TMPDIR, so
  // sockets must live under /tmp.
  const dir = await mkdtemp("/tmp/cbe-fix-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
  };
}

export async function spawnTestManager(opts: SpawnTestManagerOpts = {}): Promise<DaemonFixture> {
  const paths = await tempPaths();
  await mkdir(paths.dir, { recursive: true });

  const manager = new ManagerDaemon({
    socketPath: paths.sock,
    pidPath: paths.pid,
    lockPath: paths.lock,
    idleMs: opts.idleMs ?? 60_000,
    transport: netTransport,
    processTrackerPath: join(paths.dir, "processes.json"),
    ...opts.manager,
  });
  await manager.start();

  const client = new DaemonClient({
    socketPath: paths.sock,
    transport: netTransport,
    rpcTimeoutMs: 2_000,
    connectTimeoutMs: 2_000,
  });
  await client.connect();

  let killed = false;
  const fx: DaemonFixture = {
    dir: paths.dir,
    socketPath: paths.sock,
    pidPath: paths.pid,
    lockPath: paths.lock,
    client,
    manager,
    async kill() {
      if (killed) return;
      killed = true;
      // stop(0) shuts the manager cleanly. From the client's perspective,
      // the socket goes away — equivalent to a SIGKILL for our purposes.
      await manager.stop(0).catch(() => {});
    },
    severIncomingFrames() {
      manager.severFramesForTest();
    },
    async writePidfile(pid) {
      await writeFile(paths.pid, `${pid}\n`, "utf-8");
    },
    async stop() {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      if (!killed) {
        await manager.stop(0).catch(() => {});
        killed = true;
      }
      await rm(paths.dir, { recursive: true, force: true });
    },
  };
  return fx;
}

export interface AttachOpts {
  /** The config file the bridge loads; `fixtureSource` by default. */
  source?: InstanceSource;
  /** The client variables the bridge sends (`instanceEnvFrom`). */
  env?: Record<string, string>;
  /** The environment for the instance's STDIO servers (`childEnvFrom`). */
  childEnv?: Record<string, string>;
}

/** Writes the stub STDIO server to a file of its own; `cleanup` removes it. */
export async function stubServerFile(): Promise<{ path: string; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cbe-stub-"));
  const path = join(dir, "stub.cjs");
  await writeFile(path, STUB_STDIO_SERVER);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** The config file bridges attach with unless a test names another. */
export const fixtureSource: InstanceSource = { kind: "file", path: "/home/u/bridge.json" };

/** A manager option that serves `configs`, by config path, to instances, with no credential store or file watching. */
export function servingConfigs(configs: Record<string, Record<string, unknown>>): Pick<ManagerOptions, "_instances"> {
  return {
    _instances: {
      loadConfig: async (source) => {
        const servers = configs[source.path];
        if (servers === undefined) throw new Error(`no test config at ${source.path}`);
        return { config: BridgeConfigSchema.parse({ mcpServers: servers }), watchPaths: [] };
      },
      createCredentialStore: () => new MemoryCredentialStore() as unknown as CredentialStore,
    },
  };
}

/** A credential store holding only what a test puts in it. */
export class MemoryCredentialStore {
  readonly values = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.values.get(key);
  }
}

/** A bridge attached to an instance over its own connection, recording what the manager tells it. */
export class AttachedBridge {
  readonly snapshots = new Map<string, UpstreamSnapshot>();
  readonly logs: UpstreamLogParams[] = [];
  readonly removed: string[] = [];
  private nextCallId = 1;

  private constructor(readonly client: DaemonClient) {}

  static async attach(fx: Pick<DaemonFixture, "socketPath">, opts: AttachOpts = {}): Promise<AttachedBridge> {
    const client = new DaemonClient({ socketPath: fx.socketPath, transport: netTransport, rpcTimeoutMs: 10_000, connectTimeoutMs: 2_000 });
    const bridge = new AttachedBridge(client);
    client.setNotificationHandler((notification) => bridge._onNotification(notification));
    await client.connect();
    await client.call("ATTACH", {
      bridgeProtocolVersion: MIN_BRIDGE_PROTOCOL_VERSION,
      source: opts.source ?? fixtureSource,
      env: opts.env ?? {},
      childEnv: opts.childEnv ?? (process.env as Record<string, string>),
    });
    return bridge;
  }

  /** Waits until `name` is connected, and returns its snapshot. */
  async connected(name: string, timeoutMs = 10_000): Promise<UpstreamSnapshot> {
    await until(() => this.snapshots.get(name)?.status === "connected", timeoutMs);
    return this.snapshots.get(name)!;
  }

  callTool(upstream: string, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const callId = String(this.nextCallId++);
    return this.client.call("CALL_TOOL", { callId, upstream, name, arguments: args }, { timeoutMs: 0 }) as Promise<CallToolResult>;
  }

  /** The text of a tool call's first content block. */
  async calledText(upstream: string, name: string, args: Record<string, unknown> = {}): Promise<string | undefined> {
    const result = await this.callTool(upstream, name, args);
    const [first] = result.content as Array<{ text?: string }>;
    return first?.text;
  }

  close(): void {
    this.client.close();
  }

  private _onNotification(notification: DaemonNotification): void {
    const params = notification.params as Record<string, unknown>;
    if (notification.method === "UPSTREAM") this.snapshots.set(params.name as string, params as unknown as UpstreamSnapshot);
    else if (notification.method === "LOG") this.logs.push(params as unknown as UpstreamLogParams);
    else if (notification.method === "UPSTREAM_REMOVED") this.removed.push(params.upstream as string);
  }
}
