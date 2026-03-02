import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { StdioServerConfig } from "../config/schema.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import { hasCredentialTemplates, resolveCredentialTemplates } from "../credentials/resolve-templates.js";
import { BaseUpstreamClient } from "./base-client.js";
import type { BaseUpstreamClientOptions } from "./base-client.js";

export interface StdioUpstreamClientOptions extends BaseUpstreamClientOptions {
  config: StdioServerConfig;
  credentialStore?: CredentialStore;
}

export class StdioUpstreamClient extends BaseUpstreamClient {
  private _config: StdioServerConfig;
  private _credentialStore: CredentialStore | undefined;
  private _resolvedEnv: Record<string, string> | undefined;

  constructor(options: StdioUpstreamClientOptions) {
    super(options);
    this._config = options.config;
    this._credentialStore = options.credentialStore;
  }

  protected override async _prepareConnect(): Promise<void> {
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
}
