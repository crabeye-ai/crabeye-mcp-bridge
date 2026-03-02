import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HttpServerConfig } from "../config/schema.js";
import type { CredentialStore } from "../credentials/credential-store.js";
import { hasCredentialTemplates, resolveCredentialTemplates } from "../credentials/resolve-templates.js";
import { BaseUpstreamClient } from "./base-client.js";
import type { BaseUpstreamClientOptions } from "./base-client.js";

export interface HttpUpstreamClientOptions extends BaseUpstreamClientOptions {
  config: HttpServerConfig;
  credentialStore?: CredentialStore;
}

export class HttpUpstreamClient extends BaseUpstreamClient {
  private _config: HttpServerConfig;
  private _credentialStore: CredentialStore | undefined;
  private _resolvedHeaders: Record<string, string> | undefined;

  constructor(options: HttpUpstreamClientOptions) {
    super(options);
    this._config = options.config;
    this._credentialStore = options.credentialStore;
  }

  protected override async _prepareConnect(): Promise<void> {
    this._resolvedHeaders = undefined;
    if (
      this._credentialStore &&
      this._config.headers &&
      hasCredentialTemplates(this._config.headers as Record<string, string>)
    ) {
      this._resolvedHeaders = await resolveCredentialTemplates(
        this._config.headers as Record<string, string>,
        this._credentialStore,
      );
    }
  }

  protected _buildTransport(): Transport {
    const url = new URL(this._config.url);
    const headers = this._resolvedHeaders ?? this._config.headers;
    const requestInit: RequestInit | undefined = headers
      ? { headers: headers as Record<string, string> }
      : undefined;

    if (this._config.type !== "sse") {
      return new StreamableHTTPClientTransport(url, { requestInit });
    }
    return new SSEClientTransport(url, { requestInit });
  }
}
