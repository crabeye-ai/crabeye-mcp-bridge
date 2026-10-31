import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagerOptions } from "../../src/daemon/manager.js";
import { ProcessTracker } from "../../src/daemon/process-tracker.js";
import type { CredentialStore } from "../../src/credentials/credential-store.js";
import type { StatusResult } from "../../src/daemon/protocol.js";
import type { Telemetry, TelemetrySnapshot } from "../../src/daemon/telemetry.js";
import { AttachedBridge, fixtureSource, MemoryCredentialStore, servingConfigs, spawnTestManager, until, type AttachOpts, type DaemonFixture } from "./daemon-fixtures.js";
import { readMethodLog, STUB_METHOD_LOG_ENV, STUB_STDIO_SERVER } from "./stub-stdio-server.js";

export const FAST_RECONNECT = { reconnect: { reconnectBaseDelay: 100, reconnectMaxDelay: 1000 } };

/** A process tracker that remembers which pids it recorded and forgot, forgetting each `delayMs` late. */
export class RecordingTracker extends ProcessTracker {
  readonly registered: Array<{ pid: number; command: string; server?: string }> = [];
  readonly unregistered: number[] = [];

  constructor(
    filePath: string,
    private readonly delayMs = 0,
  ) {
    super({ filePath });
  }

  override async register(entry: Parameters<ProcessTracker["register"]>[0]): Promise<void> {
    await super.register(entry);
    this.registered.push({ pid: entry.pid, command: entry.command, server: entry.server });
  }

  override async unregister(pid: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    await super.unregister(pid);
    this.unregistered.push(pid);
  }
}

/** A real manager in a scratch directory, serving STDIO servers built on the stub, with bridges attached over its socket. */
export class StdioManagerHarness {
  fx: DaemonFixture | undefined;
  stub = "";
  methodLog = "";
  /** The configs the manager serves, by path; tests may edit them and reload. */
  configs: Record<string, Record<string, unknown>> = {};
  /** The credentials the manager's instances read. */
  credentials = new MemoryCredentialStore();
  private dir: string | undefined;
  private readonly bridges: AttachedBridge[] = [];
  private readonly scratch: string[] = [];

  async start(servers: (stub: string) => Record<string, unknown>, manager: Partial<ManagerOptions> = {}): Promise<DaemonFixture> {
    this.dir = await mkdtemp(join(tmpdir(), "cbe-stdio-"));
    this.stub = join(this.dir, "stub.cjs");
    this.methodLog = join(this.dir, "methods.log");
    await writeFile(this.stub, STUB_STDIO_SERVER);
    this.configs = { [fixtureSource.path]: servers(this.stub) };
    this.credentials = new MemoryCredentialStore();
    const serving = servingConfigs(this.configs)._instances!;
    const instances = { ...serving, createCredentialStore: () => this.credentials as unknown as CredentialStore };
    this.fx = await spawnTestManager({ manager: { childPingMs: 0, _instances: instances, ...manager } });
    return this.fx;
  }

  /** A server named `svc` running the stub with `env` added, logging the methods it gets and reconnecting quickly. */
  stubServer(extra: Record<string, unknown> = {}, env: Record<string, string> = {}): (stub: string) => Record<string, unknown> {
    return (path) => ({ svc: { command: process.execPath, args: [path], env: { [STUB_METHOD_LOG_ENV]: this.methodLog, ...env }, _bridge: FAST_RECONNECT, ...extra } });
  }

  /** A server named `svc` running the stub in a process that ignores SIGTERM. */
  sigtermIgnoringServer(): (stub: string) => Record<string, unknown> {
    return (path) => ({ svc: { command: process.execPath, args: ["-e", `process.on("SIGTERM", () => {}); require(${JSON.stringify(path)})`] } });
  }

  async attach(opts: AttachOpts = {}): Promise<AttachedBridge> {
    const bridge = await AttachedBridge.attach(this.fx!, opts);
    this.bridges.push(bridge);
    return bridge;
  }

  async status(): Promise<StatusResult> {
    return (await this.fx!.client.call("STATUS")) as StatusResult;
  }

  async childPid(): Promise<number | undefined> {
    return (await this.status()).children[0]?.pid;
  }

  /** The pid of the first child once it is one other than `previous`. */
  async nextChildPid(previous: number | undefined, timeoutMs?: number): Promise<number> {
    let pid: number | undefined;
    await until(async () => (pid = await this.childPid()) !== undefined && pid !== previous, timeoutMs);
    return pid!;
  }

  /** Restarts the first child by its hash. */
  async restartChild(): Promise<unknown> {
    return this.fx!.client.call("RESTART", { upstreamHash: (await this.status()).children[0]!.upstreamHash });
  }

  /** Makes the manager read its configs again, as a bridge attaching to them does. */
  reloadByAttaching(): Promise<AttachedBridge> {
    return this.attach();
  }

  /** The methods the stub servers got, oldest first, from every process or only from `pid`. */
  methods(pid?: number): Promise<string[]> {
    return readMethodLog(this.methodLog, pid);
  }

  telemetry(): TelemetrySnapshot {
    return (this.fx!.manager as unknown as { telemetry: Telemetry }).telemetry.snapshot();
  }

  async recordingTracker(delayMs?: number): Promise<RecordingTracker> {
    const trackerDir = await mkdtemp(join(tmpdir(), "cbe-trk-"));
    this.scratch.push(trackerDir);
    return new RecordingTracker(join(trackerDir, "processes.json"), delayMs);
  }

  async cleanUp(): Promise<void> {
    for (const bridge of this.bridges.splice(0)) bridge.close();
    await this.fx?.stop();
    this.fx = undefined;
    for (const path of [this.dir, ...this.scratch.splice(0)]) if (path !== undefined) await rm(path, { recursive: true, force: true });
    this.dir = undefined;
  }
}
