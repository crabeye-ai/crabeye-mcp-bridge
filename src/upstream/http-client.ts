import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HttpServerConfig } from "../config/schema.js";
import { BaseUpstreamClient } from "./base-client.js";
import type { BaseUpstreamClientOptions } from "./base-client.js";

export interface HttpUpstreamClientOptions extends BaseUpstreamClientOptions {
  config: HttpServerConfig;
}

export class HttpUpstreamClient extends BaseUpstreamClient {
  private _config: HttpServerConfig;

  constructor(options: HttpUpstreamClientOptions) {
    super(options);
    this._config = options.config;
  }

  protected _buildTransport(): Transport {
    const url = new URL(this._config.url);
    const requestInit: RequestInit | undefined = this._config.headers
      ? { headers: this._config.headers as Record<string, string> }
      : undefined;

    if (this._config.type !== "sse") {
      return new StreamableHTTPClientTransport(url, { requestInit });
    }
    return new SSEClientTransport(url, { requestInit });
  }
}
