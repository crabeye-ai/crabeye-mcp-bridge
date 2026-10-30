import { afterEach, beforeEach, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../src/config/loader.js";
import { loadMergedConfig } from "../../src/config/merged-loader.js";
import type { BridgeConfig } from "../../src/config/schema.js";
import { CredentialStore } from "../../src/credentials/credential-store.js";
import { createKeychainAdapter, type KeychainAdapter } from "../../src/credentials/keychain.js";
import type { StatusResult } from "../../src/daemon/protocol.js";
import { clientInfoKey, oauthCredentialKey } from "../../src/oauth/client-secret.js";
import { awaitConnectedClient } from "../../src/server/upstream-wait.js";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { InstanceLink } from "../../src/upstream/instance-link.js";
import type { InstanceUpstreamClient } from "../../src/upstream/instance-upstream-client.js";
import { UpstreamManager } from "../../src/upstream/upstream-manager.js";
import { ECHOED, startCountingUpstream, type CountingUpstream } from "./counting-http-upstream.js";
import { spawnTestManager, type DaemonFixture } from "./daemon-fixtures.js";
import { rewriteUntil } from "./rewrite-until.js";
import { recordingLogger, type LoggedLine } from "./spy-logger.js";

export const MASTER_KEY = randomBytes(32).toString("hex");

/** A `_bridge.auth` block naming the client the fixture's stored tokens were issued to. */
export const BRIDGE_AUTH = { type: "oauth2", clientId: "client-1" } as const;

export interface TestBridge {
  manager: UpstreamManager;
  lines: LoggedLine[];
  config: BridgeConfig;
  client: (name: string) => InstanceUpstreamClient;
  tools: () => string[];
  call: (server: string, tool?: string, args?: Record<string, unknown>) => Promise<unknown>;
}

/** A config with one upstream `svc` on `server`, retried quickly, with `auth` as its `_bridge.auth`, or none when it is null. */
export function oauthConfig(server: CountingUpstream, auth: unknown = BRIDGE_AUTH, extra: Record<string, unknown> = {}): unknown {
  return { mcpServers: { svc: { url: server.url, ...extra, _bridge: { reconnect: { reconnectBaseDelay: 100 }, ...(auth !== null && { auth }) } } } };
}

/** Expires `server`'s tokens and starts a call from `bridge` whose refresh the authorization server redeems but doesn't answer yet. */
export async function callWithRefreshHeld(server: CountingUpstream, bridge: TestBridge): Promise<{ call: Promise<unknown> }> {
  expect(await bridge.call("svc")).toEqual(ECHOED);
  server.holdRefreshResponses(true);
  server.expireAccessTokens();
  const call = bridge.call("svc").catch((err: unknown) => err);
  await vi.waitFor(() => expect(server.heldRefreshResponses()).toBe(1));
  return { call };
}

/** Asserts that `bridge`'s `run_tool` for `server` gets the advice to run `crabeye-mcp-bridge auth`. */
export async function expectAuthMessage(bridge: TestBridge, server = "svc"): Promise<void> {
  await expect(awaitConnectedClient(server, { getClient: (name) => bridge.manager.getClient(name) })).rejects.toThrow(
    new RegExp(`needs re-authorization[\\s\\S]*crabeye-mcp-bridge auth ${server}`),
  );
}

export class LockedKeychain implements KeychainAdapter {
  async getKey(): Promise<Buffer | undefined> {
    throw new Error("keychain is locked");
  }

  async setKey(): Promise<void> {
    throw new Error("keychain is locked");
  }

  async deleteKey(): Promise<void> {}
}

export interface DaemonOptions {
  idleMs?: number;
  watchDebounceMs?: number;
  createCredentialStore?: (env: Record<string, string>) => CredentialStore;
}

export interface SharedHttpFixture {
  /** The running daemon's directory, which also holds the test's config and credential files. */
  readonly dir: string;
  readonly daemonLines: LoggedLine[];
  daemon(opts?: DaemonOptions): Promise<DaemonFixture>;
  upstream(options?: Parameters<typeof startCountingUpstream>[0]): Promise<CountingUpstream>;
  /** Closes `closeable` after the test, with the upstreams. */
  closeLater(closeable: { close: () => Promise<void> }): void;
  writeJson(name: string, value: unknown): Promise<string>;
  rewriteJsonUntil(name: string, value: unknown, check: () => Promise<void>): Promise<void>;
  bridge(path: string, opts?: { kind?: "file" | "merged"; env?: Record<string, string> }): Promise<TestBridge>;
  status(): Promise<StatusResult>;
  credentialsPath(): string;
  storeFor(env: Record<string, string | undefined>): CredentialStore;
  /** The store the fixture's bridges and daemon use, under `MASTER_KEY`. */
  store(): CredentialStore;
  /** An upstream that requires the tokens of its own authorization server, with tokens for `serverName` stored under `MASTER_KEY`. */
  authorizedUpstream(serverName?: string, tokens?: { access: string; refresh: string }): Promise<CountingUpstream>;
}

/** Stores tokens and a registered client for `serverName`, issued by `server`'s authorization server. */
export async function storeOAuth(store: CredentialStore, serverName: string, server: CountingUpstream, accessToken: string, refreshToken: string): Promise<void> {
  await store.set(oauthCredentialKey(serverName), {
    type: "oauth2",
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    issuer: server.issuer,
  });
  await store.set(clientInfoKey(serverName), {
    type: "secret",
    value: JSON.stringify({ client_id: BRIDGE_AUTH.clientId, redirect_uris: ["http://127.0.0.1/callback"], issuer: server.issuer }),
  });
}

/** In-process bridges sharing HTTP upstreams through a test daemon; registers its hooks, so call it inside a describe. */
export function useSharedHttpFixture(): SharedHttpFixture {
  let fx: DaemonFixture | undefined;
  const daemonLines: LoggedLine[] = [];
  const closeables: Array<{ close: () => Promise<void> }> = [];
  const bridges: TestBridge[] = [];

  beforeEach(() => {
    daemonLines.length = 0;
  });

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((b) => b.manager.closeAll()));
    await fx?.stop();
    fx = undefined;
    await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const credentialsPath = () => join(fx!.dir, "credentials.enc");

  const storeFor = (env: Record<string, string | undefined>): CredentialStore => {
    if (!env.MCP_BRIDGE_MASTER_KEY) throw new Error("these tests must not reach the OS keychain");
    return new CredentialStore({ keychain: createKeychainAdapter({ env }), filePath: credentialsPath() });
  };

  const upstream = async (options: Parameters<typeof startCountingUpstream>[0] = {}): Promise<CountingUpstream> => {
    const started = await startCountingUpstream(options);
    closeables.push(started);
    return started;
  };

  const store = (): CredentialStore => storeFor({ MCP_BRIDGE_MASTER_KEY: MASTER_KEY });

  const writeJson = async (name: string, value: unknown): Promise<string> => {
    const path = join(fx!.dir, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };

  return {
    get dir() {
      return fx!.dir;
    },
    get daemonLines() {
      return daemonLines;
    },
    credentialsPath,
    storeFor,
    store,
    writeJson,
    async daemon(opts = {}) {
      fx = await spawnTestManager({
        idleMs: opts.idleMs ?? 60_000,
        manager: {
          logger: recordingLogger(daemonLines),
          _instances: { createCredentialStore: opts.createCredentialStore ?? storeFor, watchDebounceMs: opts.watchDebounceMs ?? 50 },
        },
      });
      return fx;
    },
    upstream,
    closeLater(closeable) {
      closeables.push(closeable);
    },
    rewriteJsonUntil: async (name, value, check) => {
      await rewriteUntil(() => writeJson(name, value), check);
      expect(daemonLines.filter((line) => line.level === "error")).toEqual([]);
    },
    async bridge(path, { kind = "file", env = { MCP_BRIDGE_MASTER_KEY: MASTER_KEY } } = {}) {
      const lines: LoggedLine[] = [];
      const logger = recordingLogger(lines);
      const config = kind === "file" ? await loadConfig({ configPath: path }) : (await loadMergedConfig({ bridgeConfigPath: path })).config;
      const registry = new ToolRegistry();
      const manager = new UpstreamManager({
        config,
        toolRegistry: registry,
        logger,
        credentialStore: storeFor(env),
        instanceLink: new InstanceLink({
          source: { kind, path },
          env,
          logger,
          rpcTimeoutMs: 30_000,
          heartbeatMs: 60_000,
          respawnLockWaitMs: 60_000,
          _socketPath: fx!.socketPath,
          _ensureDaemon: async () => {},
        }),
      });
      await manager.connectAll();
      const created: TestBridge = {
        manager,
        lines,
        config,
        client: (name) => manager.getClient(name) as InstanceUpstreamClient,
        tools: () => registry.listRegisteredTools().map((registered) => registered.tool.name).sort(),
        call: async (server, tool = "echo", args = {}) => (await manager.getClient(server)!.callTool({ name: tool, arguments: args })).content,
      };
      bridges.push(created);
      return created;
    },
    async status() {
      return (await fx!.client.call("STATUS")) as StatusResult;
    },
    async authorizedUpstream(serverName = "svc", tokens = { access: "at-0", refresh: "rt-0" }) {
      const server = await upstream({ oauth: true });
      await storeOAuth(store(), serverName, server, tokens.access, tokens.refresh);
      return server;
    },
  };
}
