import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { StdioServerConfig } from "../config/schema.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import { hasCredentialTemplates, resolveCredentialTemplates } from "../credentials/resolve-templates.js";
import {
  isProcessAlive,
  killProcessTree,
  type ProcessTracker,
} from "../process/index.js";
import { BaseUpstreamClient } from "./base-client.js";
import type { BaseUpstreamClientOptions } from "./base-client.js";

const SIGTERM_GRACE_MS = 5000;
const SIGKILL_GRACE_MS = 2000;

export interface StdioUpstreamClientOptions extends BaseUpstreamClientOptions {
  config: StdioServerConfig;
  credentialStore?: CredentialStore;
  processTracker?: ProcessTracker;
}

export class StdioUpstreamClient extends BaseUpstreamClient {
  private _config: StdioServerConfig;
  private _credentialStore: CredentialStore | undefined;
  private _processTracker: ProcessTracker | undefined;
  private _resolvedEnv: Record<string, string> | undefined;
  private _lastPid: number | null = null;

  constructor(options: StdioUpstreamClientOptions) {
    super(options);
    this._config = options.config;
    this._credentialStore = options.credentialStore;
    this._processTracker = options.processTracker;
  }

  override async close(): Promise<void> {
    // Kill the spawned subprocess (and its process group on POSIX, or the
    // whole process tree on Windows) before super.close() hands the
    // transport to the MCP SDK. The SDK's StdioClientTransport.close only
    // signals the direct PID, which leaks grandchildren (npx → node, shell
    // wrappers, multiprocessing pools). It also clears its internal _process
    // reference once it returns, so we'd lose the group ID.
    await this._cleanupProcess();
    await super.close();
  }

  protected override async _onTransportStarted(transport: Transport): Promise<void> {
    const pid = (transport as StdioClientTransport).pid ?? null;
    this._lastPid = pid;
    if (pid === null) return;

    this._logger.debug("subprocess started", { pid });
    if (this._processTracker) {
      try {
        await this._processTracker.register({
          pid,
          command: this._config.command,
          args: this._config.args ?? [],
          server: this.name,
          startedAt: Date.now(),
        });
      } catch (err) {
        this._logger.warn("failed to record spawned subprocess", {
          pid,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  protected override _onTransportClosed(): void {
    // Subprocess exited or peer disconnected. Remove from the persistent
    // tracker so a later startup doesn't try to kill an unrelated PID.
    // We keep _lastPid so _cleanupProcess can verify the kernel agrees.
    const pid = this._lastPid;
    if (pid !== null && this._processTracker) {
      void this._processTracker.unregister(pid).catch(() => {});
    }
  }

  protected override async _prepareConnect(): Promise<void> {
    await this._cleanupProcess();
    this._resolvedEnv = undefined;
    if (
      this._credentialStore &&
      this._config.env &&
      hasCredentialTemplates(this._config.env as Record<string, string>)
    ) {
      this._resolvedEnv = await resolveCredentialTemplates(
        this._config.env as Record<string, string>,
        this._credentialStore,
      );
    }
  }

  protected _buildTransport(): Transport {
    const env = this._resolvedEnv ?? this._config.env;
    const transport = new StdioClientTransport({
      command: this._config.command,
      args: this._config.args,
      env: { ...process.env, ...env } as Record<string, string>,
      stderr: "pipe",
    });

    // Forward subprocess stderr through the logger
    transport.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text) {
        for (const line of text.split("\n")) {
          this._logger.debug(line, { stream: "stderr" });
        }
      }
    });

    return transport;
  }

  private async _cleanupProcess(): Promise<void> {
    const pid = this._lastPid;
    if (pid === null) return;

    if (!isProcessAlive(pid)) {
      this._logger.debug("subprocess already exited", { pid });
      this._lastPid = null;
      await this._unregister(pid);
      return;
    }

    this._logger.info("cleaning up subprocess", { pid });
    const dead = await killProcessTree(pid, {
      gracefulMs: SIGTERM_GRACE_MS,
      forceMs: SIGKILL_GRACE_MS,
    });

    if (!dead) {
      this._logger.error("subprocess could not be killed", { pid });
    } else {
      this._logger.info("subprocess killed", { pid });
    }

    this._lastPid = null;
    await this._unregister(pid);
  }

  private async _unregister(pid: number): Promise<void> {
    if (!this._processTracker) return;
    try {
      await this._processTracker.unregister(pid);
    } catch {
      // Best-effort; tracker logs its own errors.
    }
  }
}
