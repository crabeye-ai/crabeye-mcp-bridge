import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR } from "../../../src/constants.js";
import { isServing } from "../../../src/daemon/net-transport.js";
import { getDaemonSocketPath } from "../../../src/daemon/paths.js";
import { connectBridgeProcess, type BridgeProcess } from "../../_helpers/bridge-process.js";
import { until } from "../../_helpers/daemon-fixtures.js";
import { startCountingUpstream, type CountingUpstream } from "../../_helpers/counting-http-upstream.js";
import { viaRunTool } from "../../_helpers/run-tool.js";
import { bundleForSubprocess } from "../../_helpers/subprocess-bundle.js";

const isWindows = process.platform === "win32";
const run = promisify(execFile);

describe("credentials read by the detached daemon", { timeout: 90_000 }, () => {
  let cliScript: string;
  let home: string;
  let server: CountingUpstream;
  let bridges: BridgeProcess[] = [];
  const masterKey = randomBytes(32).toString("hex");

  beforeAll(async () => {
    if (isWindows && (await isServing(getDaemonSocketPath()))) {
      throw new Error("a crabeye daemon is already running for this user; stop it before running this test");
    }
    cliScript = await bundleForSubprocess("src/index.ts", "cli-instance-keychain");
  });

  beforeEach(async () => {
    home = await mkdtemp(isWindows ? join(tmpdir(), "cbe-kc-") : "/tmp/cbe-kc-");
    await mkdir(join(home, CREDENTIALS_DIR));
    await writeFile(join(home, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), JSON.stringify({ _bridge: { daemon: { killGraceMs: 0 } } }));
    server = await startCountingUpstream();
  });

  afterEach(async () => {
    await Promise.all(bridges.map((bridge) => bridge.client.close().catch(() => {})));
    bridges = [];
    await run(process.execPath, [cliScript, "daemon", "stop"], { env: env() }).catch(() => {});
    await server.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 30_000);

  /** On Windows the daemon reads the master key with DPAPI; elsewhere the tests never reach the OS keychain. */
  function env(): NodeJS.ProcessEnv {
    const scratch: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home, "AppData", "Local") };
    if (isWindows) delete scratch.MCP_BRIDGE_MASTER_KEY;
    else scratch.MCP_BRIDGE_MASTER_KEY = masterKey;
    return scratch;
  }

  async function configWithStoredToken(): Promise<string> {
    await run(process.execPath, [cliScript, "credential", "set", "token", "from-the-store"], { env: env() });
    const configPath = join(home, "client.json");
    await writeFile(configPath, JSON.stringify({ mcpServers: { svc: { url: server.url, headers: { Authorization: "Bearer ${credential:token}" } } } }));
    return configPath;
  }

  async function connect(configPath: string, environment: NodeJS.ProcessEnv): Promise<BridgeProcess> {
    const bridge = await connectBridgeProcess(cliScript, configPath, environment);
    bridges.push(bridge);
    return bridge;
  }

  async function daemonStatus(): Promise<{ upstreams?: Array<{ server: string; state: string }> }> {
    const { stdout } = await run(process.execPath, [cliScript, "daemon", "status"], { env: env() });
    return JSON.parse(stdout);
  }

  it("connects with the credential the CLI stored, read through the keychain in the daemon process", async () => {
    const bridge = await connect(await configWithStoredToken(), env());

    const result = await bridge.client.callTool(viaRunTool("svc__echo"));

    expect(result).toMatchObject({ content: [{ type: "text", text: "called echo {}" }] });
    expect(server.authorizations()).toContain("Bearer from-the-store");
    expect(await daemonStatus()).toMatchObject({ upstreams: [{ server: "svc", state: "connected" }] });
  });

  it("refreshes the tokens of an upstream with _bridge.auth with the client secret the CLI stored, read through the keychain in the daemon process", async () => {
    const authorizing = await startCountingUpstream({ oauth: true });
    try {
      const set = (key: string, ...value: string[]) => run(process.execPath, [cliScript, "credential", "set", key, ...value], { env: env() });
      await set("oauth:svc", "--json", JSON.stringify({ type: "oauth2", access_token: "at-0", refresh_token: "rt-0", token_type: "Bearer", issuer: authorizing.issuer }));
      await set("oauth-client-secret:svc", "secret-from-the-store");
      const configPath = join(home, "client.json");
      await writeFile(configPath, JSON.stringify({ mcpServers: { svc: { url: authorizing.url, _bridge: { auth: { type: "oauth2", clientId: "client-1" } } } } }));
      const bridge = await connect(configPath, env());
      expect(await bridge.client.callTool(viaRunTool("svc__echo"))).toMatchObject({ content: [{ type: "text", text: "called echo {}" }] });

      authorizing.expireAccessTokens();

      expect(await bridge.client.callTool(viaRunTool("svc__echo"))).toMatchObject({ content: [{ type: "text", text: "called echo {}" }] });
      expect(authorizing.tokenRequestLog()).toEqual([{ grantType: "refresh_token", clientId: "client-1", clientSecret: "secret-from-the-store", refreshToken: "rt-0" }]);
      expect(await daemonStatus()).toMatchObject({ upstreams: [{ server: "svc", state: "connected" }] });
      expect(authorizing.count("tools/list")).toBe(1);
    } finally {
      await authorizing.close();
    }
  });

  it.skipIf(isWindows)("doesn't let a client whose entry sets another master key use credentials stored under this one", async () => {
    const configPath = await configWithStoredToken();
    const owner = await connect(configPath, env());
    expect(await owner.client.callTool(viaRunTool("svc__echo"))).toMatchObject({ content: [{ type: "text", text: "called echo {}" }] });

    const other = await connect(configPath, { ...env(), MCP_BRIDGE_MASTER_KEY: randomBytes(32).toString("hex") });

    const states = async () => (await daemonStatus()).upstreams?.map((row) => row.state).sort();
    await until(async () => JSON.stringify(await states()) === JSON.stringify(["connected", "disconnected"]), 20_000);
    await until(() => other.stderr().includes("[upstream:svc] failed to connect"), 10_000);
    expect(new Set(server.authorizations().filter((value) => value !== undefined))).toEqual(new Set(["Bearer from-the-store"]));
    expect(server.count("tools/list")).toBe(1);
  });
});
