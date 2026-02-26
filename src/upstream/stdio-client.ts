import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { StdioServerConfig } from "../config/schema.js";
import { BaseUpstreamClient } from "./base-client.js";
import type { BaseUpstreamClientOptions } from "./base-client.js";

export interface StdioUpstreamClientOptions extends BaseUpstreamClientOptions {
  config: StdioServerConfig;
}

export class StdioUpstreamClient extends BaseUpstreamClient {
  private _config: StdioServerConfig;

  constructor(options: StdioUpstreamClientOptions) {
    super(options);
    this._config = options.config;
  }

  protected _buildTransport(): Transport {
    const transport = new StdioClientTransport({
      command: this._config.command,
      args: this._config.args,
      env: { ...process.env, ...this._config.env } as Record<string, string>,
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
