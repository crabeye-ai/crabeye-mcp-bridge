import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { StdioServerConfig } from "../config/schema.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import { hasCredentialTemplates, resolveCredentialTemplates } from "../credentials/resolve-templates.js";
import { BaseUpstreamClient } from "./base-client.js";
import type { BaseUpstreamClientOptions } from "./base-client.js";

const SIGTERM_GRACE_MS = 5000;
const SIGKILL_GRACE_MS = 2000;
const POLL_INTERVAL_MS = 100;

export interface StdioUpstreamClientOptions extends BaseUpstreamClientOptions {
  config: StdioServerConfig;
  credentialStore?: CredentialStore;
}

export class StdioUpstreamClient extends BaseUpstreamClient {
  private _config: StdioServerConfig;
  private _credentialStore: CredentialStore | undefined;
  private _resolvedEnv: Record<string, string> | undefined;
  private _lastPid: number | null = null;

  constructor(options: StdioUpstreamClientOptions) {
    super(options);
    this._config = options.config;
    this._credentialStore = options.credentialStore;
  }

  protected override _afterConnect(transport: Transport): void {
    const pid = (transport as StdioClientTransport).pid ?? null;
    this._lastPid = pid;
    if (pid !== null) {
      this._logger.debug("subprocess started", { pid });
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

    if (!this._isProcessAlive(pid)) {
      this._logger.debug("subprocess already exited", { pid });
      this._lastPid = null;
      return;
    }

    this._logger.info("cleaning up subprocess", { pid });

    // Step 1: SIGTERM to process group
    if (!this._sendSignal(pid, "SIGTERM")) {
      this._lastPid = null;
      return;
    }

    // Step 2: Wait for graceful exit
    if (await this._waitForExit(pid, SIGTERM_GRACE_MS)) {
      this._logger.info("subprocess exited after SIGTERM", { pid });
      this._lastPid = null;
      return;
    }

    // Step 3: SIGKILL
    this._logger.warn("subprocess did not exit after SIGTERM, sending SIGKILL", { pid });
    this._sendSignal(pid, "SIGKILL");
    await this._waitForExit(pid, SIGKILL_GRACE_MS);

    if (this._isProcessAlive(pid)) {
      this._logger.error("subprocess could not be killed", { pid });
    } else {
      this._logger.info("subprocess killed", { pid });
    }

    this._lastPid = null;
  }

  /**
   * Send a signal to the process group first, falling back to the PID.
   * Returns false if the process is already gone.
   */
  private _sendSignal(pid: number, signal: NodeJS.Signals): boolean {
    try {
      process.kill(-pid, signal); // process group
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return false; // already dead
      // EPERM on process group — try PID directly
      try {
        process.kill(pid, signal);
        return true;
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw err2;
      }
    }
  }

  private _isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private _waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const interval = setInterval(() => {
        if (!this._isProcessAlive(pid)) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve(true);
        }
      }, POLL_INTERVAL_MS);
      const timer = setTimeout(() => {
        clearInterval(interval);
        resolve(false);
      }, timeoutMs);
    });
  }
}
