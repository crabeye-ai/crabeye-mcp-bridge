import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BRIDGE_CONFIG_FILENAME,
  CREDENTIALS_DIR,
  CREDENTIALS_FILENAME,
  DAEMON_DIR,
  DAEMON_PID_FILENAME,
  DAEMON_RUN_SUBDIR,
  DAEMON_SOCKET_FILENAME,
} from "../../../src/constants.js";
import { CredentialStore } from "../../../src/credentials/credential-store.js";
import { createKeychainAdapter } from "../../../src/credentials/keychain.js";
import { daemonStatus } from "../../../src/daemon/bootstrap.js";
import { oauthCredentialKey } from "../../../src/oauth/client-secret.js";
import { connectBridgeProcess, type BridgeProcess } from "../../_helpers/bridge-process.js";
import { browserShim, type BrowserShim } from "../../_helpers/browser-shim.js";
import { ECHOED, startCountingUpstream, type CountingUpstream } from "../../_helpers/counting-http-upstream.js";
import { viaRunTool } from "../../_helpers/run-tool.js";
import { BRIDGE_AUTH, storeOAuth } from "../../_helpers/shared-http-fixture.js";
import { bundleForSubprocess } from "../../_helpers/subprocess-bundle.js";

const MASTER_KEY = randomBytes(32).toString("hex");
const run = promisify(execFile);
const AUTHORIZE_AGAIN = 'Upstream server "svc" needs re-authorization. Run: crabeye-mcp-bridge auth svc';

describe.skipIf(process.platform === "win32")("crabeye-mcp-bridge auth with bridges sharing an upstream through the manager", { timeout: 90_000 }, () => {
  let cliScript: string;
  let dir: string;
  let browser: BrowserShim;
  const bridges: BridgeProcess[] = [];
  const upstreams: CountingUpstream[] = [];

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-auth-instances");
  }, 180_000);

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.client.close().catch(() => {})));
    await run(process.execPath, [cliScript, "daemon", "stop"], { env: env() }).catch(() => {});
    await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
    await rm(dir, { recursive: true, force: true });
  }, 30_000);

  function env(): NodeJS.ProcessEnv {
    const inherited = { ...process.env };
    delete inherited.MCP_BRIDGE_CONFIG;
    return { ...inherited, HOME: dir, MCP_BRIDGE_MASTER_KEY: MASTER_KEY, PATH: browser.path };
  }

  const runFiles = () => join(dir, DAEMON_DIR, DAEMON_RUN_SUBDIR);
  const socketPath = () => join(runFiles(), DAEMON_SOCKET_FILENAME);

  async function workspace(server: Record<string, unknown>): Promise<{ configPath: string; upstream: CountingUpstream }> {
    dir = await mkdtemp("/tmp/cbe-auth-");
    browser = await browserShim(dir);
    await mkdir(join(dir, CREDENTIALS_DIR));
    await writeFile(join(dir, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: 0 } } }));
    const upstream = await startCountingUpstream({ oauth: true });
    upstreams.push(upstream);
    const configPath = join(dir, "client.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { svc: { url: upstream.url, ...server } } }));
    return { configPath, upstream };
  }

  function store(): CredentialStore {
    return new CredentialStore({
      keychain: createKeychainAdapter({ env: { MCP_BRIDGE_MASTER_KEY: MASTER_KEY } }),
      filePath: join(dir, CREDENTIALS_DIR, CREDENTIALS_FILENAME),
    });
  }

  const storeTokens = (upstream: CountingUpstream) => storeOAuth(store(), "svc", upstream, "at-0", "rt-0");

  async function connect(configPath: string): Promise<BridgeProcess> {
    const bridge = await connectBridgeProcess(cliScript, configPath, env());
    bridges.push(bridge);
    return bridge;
  }

  async function cli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
    return run(process.execPath, [cliScript, ...args], { env: env() });
  }

  async function httpUpstreams(): Promise<unknown> {
    return JSON.parse((await cli("daemon", "status")).stdout).httpUpstreams;
  }

  async function runTool(bridge: BridgeProcess): Promise<{ content: Array<{ text?: string }>; isError?: boolean }> {
    return (await bridge.client.callTool(viaRunTool("svc__echo"))) as { content: Array<{ text?: string }>; isError?: boolean };
  }

  async function expectAuthMessage(bridge: BridgeProcess): Promise<void> {
    const result = await runTool(bridge);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(AUTHORIZE_AGAIN);
  }

  it.each([
    ["with _bridge.auth", { _bridge: { auth: BRIDGE_AUTH } }],
    ["without _bridge.auth", {}],
  ])("connects an upstream %s that needs authorization for every client as soon as auth finishes", async (_label, server) => {
    const { configPath, upstream } = await workspace(server);
    const clients = [await connect(configPath), await connect(configPath)];
    for (const each of clients) await expectAuthMessage(each);

    const { stdout } = await cli("--config", configPath, "auth", "svc");

    expect(stdout.split("\n")[0]).toBe('Authenticated "svc"');
    expect(await browser.opened()).toHaveLength(1);
    expect(await browser.failures()).toEqual([]);
    expect(await httpUpstreams()).toEqual([{ server: "svc", state: "connected", instances: 1 }]);
    expect(upstream.count("tools/call")).toBe(0);
    for (const each of clients) expect(await runTool(each)).toMatchObject({ content: ECHOED });
  });

  it("pauses the upstream for every client as soon as auth --remove deletes its credentials", async () => {
    const { configPath, upstream } = await workspace({ _bridge: { auth: { type: "oauth2" } } });
    await storeTokens(upstream);
    const clients = [await connect(configPath), await connect(configPath)];
    for (const each of clients) expect(await runTool(each)).toMatchObject({ content: ECHOED });

    const { stdout, stderr } = await cli("--config", configPath, "auth", "--remove", "svc");

    expect(stdout).toBe('Removed local token + registered client for "svc"\n');
    expect(stderr).toBe("");
    expect(await httpUpstreams()).toEqual([{ server: "svc", state: "auth_required", instances: 1 }]);
    for (const each of clients) await expectAuthMessage(each);
  });

  it("prints its usual output and starts no manager when none is running", async () => {
    const { configPath, upstream } = await workspace({ _bridge: { auth: BRIDGE_AUTH } });
    await storeTokens(upstream);

    expect(await cli("--config", configPath, "auth", "--remove", "svc")).toEqual({ stdout: 'Removed local token + registered client for "svc"\n', stderr: "" });
    const login = await cli("--config", configPath, "auth", "svc");

    expect(login.stdout).toMatch(/^Authenticated "svc"\n {2}Expires: .+\n$/);
    expect(await browser.failures()).toEqual([]);
    expect(await store().get(oauthCredentialKey("svc"))).toMatchObject({ access_token: "at-1" });
    expect(await daemonStatus(socketPath())).toBeNull();
    expect(existsSync(socketPath())).toBe(false);
    expect(existsSync(join(runFiles(), DAEMON_PID_FILENAME))).toBe(false);
  });
});
