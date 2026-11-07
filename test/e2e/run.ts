import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { startCountingUpstream, type CountingUpstream } from "../_helpers/counting-http-upstream.js";
import { browserShim, type BrowserShim } from "../_helpers/browser-shim.js";
import { installReleasedBridge } from "../_helpers/released-bridge.js";
import { STUB_METHOD_LOG_ENV, STUB_STDIO_SERVER, STUB_STRICT_ENV } from "../_helpers/stub-stdio-server.js";

const CLI = process.argv[2]!;
const RELEASED = join(await installReleasedBridge("1.3.0"), "node_modules", "@crabeye-ai", "crabeye-mcp-bridge", "dist", "index.js");
const MASTER_KEY = randomBytes(32).toString("hex");
const AUTH = { type: "oauth2", clientId: "client-1" };
const run = promisify(execFile);
const results: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(50);
  }
  return false;
}

interface DaemonStatusJson {
  pid: number;
  children?: { pid: number; upstreamHash?: string }[];
  upstreams?: { server: string; type: string; state: string; instances: number; upstreamHash?: string }[];
}

interface Bridge {
  client: Client;
  stderr: () => string;
  close: () => Promise<void>;
}

interface Home {
  dir: string;
  clientFile: string;
  browser: BrowserShim;
  env: (extra?: Record<string, string>) => Record<string, string>;
  bridge: (opts?: { modern?: boolean; script?: string; env?: Record<string, string>; elicit?: (message: string) => Promise<"accept" | "decline"> }) => Promise<Bridge>;
  cli: (...args: string[]) => Promise<{ stdout: string; stderr: string }>;
  status: () => Promise<DaemonStatusJson>;
  daemonLog: () => Promise<string>;
  cleanUp: () => Promise<void>;
}

async function home(servers: Record<string, unknown>): Promise<Home> {
  const dir = await mkdtemp("/tmp/cbe-e2e-");
  const browser = await browserShim(dir);
  const clientFile = join(dir, "client.json");
  await writeFile(clientFile, JSON.stringify({ mcpServers: servers }));
  await mkdir(join(dir, ".crabeye-mcp-bridge"));
  await writeFile(
    join(dir, ".crabeye-mcp-bridge", "config.json"),
    JSON.stringify({ configPaths: [clientFile], _bridge: { logLevel: "debug", daemon: { killGraceMs: 0, idleMs: 1_500 } } }),
  );
  const bridges: Bridge[] = [];
  const env = (extra: Record<string, string> = {}) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
    delete out.MCP_BRIDGE_CONFIG;
    return { ...out, HOME: dir, MCP_BRIDGE_MASTER_KEY: MASTER_KEY, PATH: browser.path, ...extra };
  };
  const scripts = new Set<string>([CLI]);
  const cli = (...args: string[]) => run(process.execPath, [CLI, ...args], { env: env() });
  return {
    dir,
    clientFile,
    browser,
    env,
    cli,
    bridge: async ({ modern = false, script = CLI, env: extra, elicit } = {}) => {
      scripts.add(script);
      const transport = new StdioClientTransport({ command: process.execPath, args: [script], env: env(extra), stderr: "pipe" });
      let stderr = "";
      transport.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      const client = new Client({ name: "e2e", version: "0" }, { ...(modern && { versionNegotiation: { mode: "auto" } }), ...(elicit && { capabilities: { elicitation: {} } }) });
      if (elicit !== undefined) {
        client.setRequestHandler("elicitation/create", async (request) => {
          const action = await elicit(request.params.message);
          return action === "accept" ? { action, content: {} } : { action };
        });
      }
      await client.connect(transport);
      const bridge = { client, stderr: () => stderr, close: () => client.close().catch(() => {}) };
      bridges.push(bridge);
      return bridge;
    },
    status: async () => JSON.parse((await cli("daemon", "status")).stdout),
    daemonLog: () => readFile(join(dir, ".crabeye", "logs", "daemon.log"), "utf8").catch(() => ""),
    cleanUp: async () => {
      await Promise.all(bridges.map((b) => b.close()));
      for (const script of scripts) await run(process.execPath, [script, "daemon", "stop"], { env: env() }).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const textOf = (result: { content?: unknown }): string =>
  (Array.isArray(result.content) ? result.content : []).map((c: unknown) => (typeof c === "object" && c !== null && "text" in c ? String(c.text) : "")).join("");
const runTool = (bridge: Bridge, name = "svc__echo") => bridge.client.callTool({ name: "run_tool", arguments: { name, arguments: {} } });
const echoes = async (bridge: Bridge, name = "svc__echo") => textOf(await runTool(bridge, name)) === "called echo {}";
const asksForAuth = async (bridge: Bridge) => textOf(await runTool(bridge)).includes('needs re-authorization. Run: crabeye-mcp-bridge auth svc');
const svcState = async (h: Home) => (await h.status()).upstreams?.filter((u) => u.server === "svc").map((u) => u.state);

async function storeTokens(h: Home, server: CountingUpstream, access = "at-0", refresh = "rt-0"): Promise<void> {
  await h.cli("credential", "set", "oauth:svc", "--json", JSON.stringify({ type: "oauth2", access_token: access, refresh_token: refresh, token_type: "Bearer", issuer: server.issuer }));
}

async function refreshAcross(h: Home, server: CountingUpstream, clients: Bridge[], label: string): Promise<void> {
  const before = server.tokenRequests();
  const refused = server.unauthorizedResponses();
  server.holdRefreshResponses(true);
  server.expireAccessTokens();
  const calls = clients.map((c) => runTool(c));
  const allRefused = await until(() => server.unauthorizedResponses() >= refused + clients.length, 10_000);
  const held = await until(() => server.heldRefreshResponses() === 1, 10_000);
  await sleep(300);
  const stillOne = server.heldRefreshResponses() === 1;
  server.holdRefreshResponses(false);
  const texts = (await Promise.all(calls)).map(textOf);
  check(`${label}: every client's call as the tokens expired worked`, texts.every((t) => t === "called echo {}"), texts.join(" | "));
  check(`${label}: the server saw exactly one refresh`, allRefused && held && stillOne && server.tokenRequests() - before === 1, `refreshes=${server.tokenRequests() - before} held=${server.heldRefreshResponses()}`);
}

async function sharedAuth(): Promise<void> {
  console.log("\n# two clients (legacy and modern MCP clients) on the default config, an upstream with _bridge.auth");
  const server = await startCountingUpstream({ oauth: true });
  const h = await home({ svc: { url: server.url, _bridge: { auth: AUTH } } });
  try {
    await storeTokens(h, server);
    const [a, b] = [await h.bridge(), await h.bridge({ modern: true })];
    check("legacy-client bridge runs svc__echo", await echoes(a));
    check("modern-client bridge runs svc__echo", await echoes(b));
    const search = textOf(await b.client.callTool({ name: "search_tools", arguments: { queries: [{ provider: "svc" }] } }));
    check("search_tools lists svc's 2 tools", /"tool_count":2/.test(search), search.slice(0, 120));
    check("one connection: the server saw one tools/list", server.count("tools/list") === 1, `n=${server.count("tools/list")}`);
    check("daemon status shows svc connected, held by one instance", JSON.stringify((await h.status()).upstreams) === JSON.stringify([{ server: "svc", type: "streamable-http", state: "connected", instances: 1 }]));
    await refreshAcross(h, server, [a, b], "one connection");

    console.log("\n# a third client whose network settings give it its own connection");
    const c = await h.bridge({ env: { NODE_EXTRA_CA_CERTS: join(h.dir, "extra.pem") } });
    check("third client runs svc__echo", await echoes(c));
    check("daemon status shows two svc connections", JSON.stringify(await svcState(h)) === JSON.stringify(["connected", "connected"]));
    await refreshAcross(h, server, [a, c], "two connections");

    console.log("\n# auth --remove while connected");
    const removed = await h.cli("auth", "--remove", "svc");
    check("auth --remove prints the removal", removed.stdout.startsWith('Removed local token') && removed.stdout.endsWith('for "svc"\n') && removed.stderr === "", JSON.stringify(removed));
    check("daemon status shows every svc connection paused right away", JSON.stringify(await svcState(h)) === JSON.stringify(["auth_required", "auth_required"]), JSON.stringify(await svcState(h)));
    check("every client's run_tool asks for auth", (await asksForAuth(a)) && (await asksForAuth(b)) && (await asksForAuth(c)));

    console.log("\n# auth while paused");
    const calls = server.count("tools/call");
    const login = await h.cli("auth", "svc");
    check("auth prints Authenticated", login.stdout.split("\n")[0] === 'Authenticated "svc"', JSON.stringify(login.stdout));
    check("the browser stand-in was used once", (await h.browser.opened()).length === 1);
    check("daemon status shows every svc connection connected before any call", JSON.stringify(await svcState(h)) === JSON.stringify(["connected", "connected"]) && server.count("tools/call") === calls);
    check("every client's next run_tool works", (await echoes(a)) && (await echoes(b)) && (await echoes(c)));

    console.log("\n# an edit to _bridge.auth");
    const lists = server.count("tools/list");
    await writeFile(h.clientFile, JSON.stringify({ mcpServers: { svc: { url: server.url, _bridge: { auth: { ...AUTH, scopes: ["read"] } } } } }));
    check("the manager reconnected both connections", await until(() => server.count("tools/list") >= lists + 2, 15_000), `tools/list +${server.count("tools/list") - lists}`);
    check("the manager log says it reconnected svc", /reconnecting server.*svc|svc.*reconnecting server/.test(await h.daemonLog()));
    check("every client still works after the edit", await until(async () => (await echoes(a)) && (await echoes(b)) && (await echoes(c)), 10_000));
  } finally {
    await h.cleanUp();
    await server.close();
  }
}

async function noManager(): Promise<void> {
  console.log("\n# auth and auth --remove with no manager running");
  const server = await startCountingUpstream({ oauth: true });
  const h = await home({ svc: { url: server.url, _bridge: { auth: AUTH } } });
  try {
    await storeTokens(h, server);
    const socket = join(h.dir, ".crabeye", "run", "manager.sock");
    const removed = await h.cli("auth", "--remove", "svc");
    check("auth --remove prints only the removal", removed.stdout === 'Removed local token for "svc"\n' && removed.stderr === "", JSON.stringify(removed));
    const login = await h.cli("auth", "svc");
    check("auth prints Authenticated and the expiry", /^Authenticated "svc"\n {2}Expires: .+\n$/.test(login.stdout), JSON.stringify(login.stdout));
    const status = await h.cli("daemon", "status").then((r) => r.stdout + r.stderr, (err) => String(err.stdout ?? "") + String(err.stderr ?? ""));
    check("no manager was started", !existsSync(socket) && /"running": false/.test(status), status.trim());
  } finally {
    await h.cleanUp();
    await server.close();
  }
}

async function beside130(): Promise<void> {
  console.log("\n# a 1.3.0 bridge beside a current one, upstream with _bridge.auth");
  const server = await startCountingUpstream({ oauth: true });
  const h = await home({ svc: { url: server.url, _bridge: { auth: AUTH } } });
  try {
    await storeTokens(h, server);
    const current = await h.bridge();
    const old = await h.bridge({ script: RELEASED });
    check("current bridge runs svc__echo", await echoes(current));
    check("1.3.0 bridge runs svc__echo", await echoes(old));
    check("two connections: the manager's and the 1.3.0 bridge's own", server.count("tools/list") === 2, `n=${server.count("tools/list")}`);
    server.expireAccessTokens();
    check("both work after the tokens expire", (await echoes(current)) && (await echoes(old)));
  } finally {
    await h.cleanUp();
    await server.close();
  }
}

async function stubHome(env: Record<string, string> = {}): Promise<{ h: Home; lastChild: () => Promise<{ pids: number; methods: string[] }> }> {
  const scratch = await mkdtemp("/tmp/cbe-e2e-stub-");
  const stub = join(scratch, "stub.cjs");
  const methodLog = join(scratch, "methods.log");
  await writeFile(stub, STUB_STDIO_SERVER);
  const h = await home({ stub: { command: process.execPath, args: [stub], env: { [STUB_METHOD_LOG_ENV]: methodLog, ...env }, _bridge: { reconnect: { reconnectBaseDelay: 100, reconnectMaxDelay: 1000 } } } });
  const cleanUp = h.cleanUp;
  h.cleanUp = async () => {
    await cleanUp();
    await rm(scratch, { recursive: true, force: true });
  };
  const lastChild = async () => {
    const lines = (await readFile(methodLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
    const pids = [...new Set(lines.map((l) => l.slice(0, l.indexOf(" "))))];
    const last = pids.at(-1);
    return { pids: pids.length, methods: lines.filter((l) => l.startsWith(`${last} `)).map((l) => l.slice(l.indexOf(" ") + 1)) };
  };
  return { h, lastChild };
}

const stubText = async (bridge: Bridge, tool: string, args: Record<string, unknown> = {}) =>
  textOf(await bridge.client.callTool({ name: "run_tool", arguments: { name: `stub__${tool}`, arguments: args } }));

async function stdioShared(): Promise<void> {
  console.log("\n# two clients (legacy and modern) on the default config with only a STDIO server");
  const { h, lastChild } = await stubHome();
  try {
    const a = await h.bridge({ env: { MARKER: "first" } });
    const b = await h.bridge({ modern: true, env: { MARKER: "second" } });
    check("legacy-client bridge runs stub__plain", (await stubText(a, "plain")) === "called plain");
    check("modern-client bridge runs stub__plain", (await stubText(b, "plain")) === "called plain");
    const status = await h.status();
    check("one child for both clients", status.children?.length === 1, JSON.stringify(status.children));
    const { pids, methods } = await lastChild();
    check("the child got one initialize and one tools/list", pids === 1 && methods.filter((m) => m === "initialize").length === 1 && methods.filter((m) => m === "tools/list").length === 1, `${pids} ${methods.join(",")}`);
    check("daemon status lists stub as a connected stdio upstream with the restart hash", JSON.stringify(status.upstreams) === JSON.stringify([{ server: "stub", type: "stdio", state: "connected", instances: 1, upstreamHash: status.children?.[0]?.upstreamHash }]), JSON.stringify(status.upstreams));
    const env = JSON.parse(await stubText(b, "env"));
    check("the child has the first client's environment", env.MARKER === "first", env.MARKER);
    check("the child has no master key", env.MCP_BRIDGE_MASTER_KEY === undefined);
    await stubText(a, "stderr", { text: "e2e-stderr-line" });
    check("a stderr line reaches both clients' logs", await until(() => a.stderr().includes("e2e-stderr-line") && b.stderr().includes("e2e-stderr-line"), 10_000));
    check("the manager log never shows the master key", !(await h.daemonLog()).includes(MASTER_KEY));
  } finally {
    await h.cleanUp();
  }
}

async function stdioRespawn(): Promise<void> {
  console.log("\n# a strict legacy STDIO server, the manager killed under two clients");
  const { h, lastChild } = await stubHome({ [STUB_STRICT_ENV]: "1" });
  try {
    const a = await h.bridge();
    const b = await h.bridge({ modern: true });
    check("both clients call the strict server", (await stubText(a, "plain")) === "called plain" && (await stubText(b, "plain")) === "called plain");
    const { pid } = await h.status();
    process.kill(pid, "SIGKILL");
    check("the first client's next call works on a new manager", await until(async () => (await stubText(a, "plain")) === "called plain", 30_000));
    check("the second client's next call works", (await stubText(b, "plain")) === "called plain");
    const after = await h.status();
    check("a new manager serves", after.pid !== pid, `${pid} -> ${after.pid}`);
    const { pids, methods } = await lastChild();
    check("the new manager started a new child", pids === 2, String(pids));
    const init = methods.indexOf("initialize");
    check("the new child got only the version check before one initialize, then initialized", init >= 0 && methods.slice(0, init).every((m) => m === "server/discover") && methods.filter((m) => m === "initialize").length === 1 && methods[init + 1] === "notifications/initialized", methods.join(","));
  } finally {
    await h.cleanUp();
  }
}

async function searchAndLimits(): Promise<void> {
  console.log("\n# two clients searching one index and sharing one rate limit");
  const scratch = await mkdtemp("/tmp/cbe-e2e-limit-");
  const stub = join(scratch, "stub.cjs");
  await writeFile(stub, STUB_STDIO_SERVER);
  const h = await home({ stub: { command: process.execPath, args: [stub], _bridge: { category: "testing", rateLimit: { maxCalls: 2, windowSeconds: 3 } } } });
  try {
    const a = await h.bridge();
    const b = await h.bridge({ modern: true });
    const search = async (bridge: Bridge) => textOf(await bridge.client.callTool({ name: "search_tools", arguments: { queries: [{ category: "test", expand_tools: true }] } }));
    check("both clients find the server's tools by its category", await until(async () => (await search(a)).includes("stub__plain") && (await search(b)).includes("stub__plain"), 20_000));
    check("both clients get the same search results", (await search(a)) === (await search(b)));
    const regexStartedAt = Date.now();
    const regexSearch = textOf(await b.client.callTool({ name: "search_tools", arguments: { queries: [{ tool: "regex:(\\w+)+!|x{17}", expand_tools: true }, { tool: "regex:^(\\w+\\s?)*$", expand_tools: true }] } }));
    const regexMs = Date.now() - regexStartedAt;
    check("a search whose regexes would backtrack without end answers at once", regexSearch.startsWith('{"results"') && regexMs < 2_000, `${regexMs} ms`);
    check("the other client is still served right after it", (await search(a)).includes("stub__plain"));
    await sleep(3_100);
    const startedAt = Date.now();
    await Promise.all([stubText(a, "plain"), stubText(b, "plain")]);
    const quick = Date.now() - startedAt;
    const third = await stubText(a, "plain");
    const held = Date.now() - startedAt;
    check("two calls across both clients run at once", quick < 1_000, `${quick} ms`);
    check("a third call within the window waits for it to open", third === "called plain" && held >= 2_000, `${held} ms`);
  } finally {
    await h.cleanUp();
    await rm(scratch, { recursive: true, force: true });
  }
}

async function stdioBeside130(): Promise<void> {
  console.log("\n# a 1.3.0 bridge with the STDIO server beside a current one");
  const { h } = await stubHome();
  try {
    const current = await h.bridge();
    check("current bridge runs stub__plain", (await stubText(current, "plain")) === "called plain");
    const { pid } = await h.status();
    const old = await h.bridge({ script: RELEASED });
    check("1.3.0 bridge logs that its AI client needs restarting", await until(() => old.stderr().includes("restart the AI client"), 30_000), old.stderr().slice(-300));
    await sleep(2_000);
    check("current bridge still works", (await stubText(current, "plain")) === "called plain");
    check("the manager kept its pid", (await h.status()).pid === pid);
  } finally {
    await h.cleanUp();
  }
}

async function policyAndReload(): Promise<void> {
  console.log("\n# tool policy and config reload decided by the manager for every client");
  const scratch = await mkdtemp("/tmp/cbe-e2e-policy-");
  const stub = join(scratch, "stub.cjs");
  await writeFile(stub, STUB_STDIO_SERVER);
  const server = (bridge: Record<string, unknown>) => ({ command: process.execPath, args: [stub], _bridge: bridge });
  const h = await home({ stub: server({ toolPolicy: "prompt" }) });
  try {
    const legacyPrompts: string[] = [];
    const modernPrompts: string[] = [];
    const a = await h.bridge({ elicit: async (m) => (legacyPrompts.push(m), "accept") });
    const b = await h.bridge({ modern: true, elicit: async (m) => (modernPrompts.push(m), "decline") });
    const hidden = `ok${String.fromCodePoint(0x202e)}${String.fromCodePoint(0xe0072)}`;
    const [ran, declined] = await Promise.all([stubText(a, "plain", { note: hidden }), stubText(b, "plain")]);
    check("the legacy client approved its call and it ran", ran === "called plain", ran);
    check("the modern client declined its call and it didn't run", declined === "Tool stub__plain was declined by user", declined);
    check("each client was asked once about its own call", legacyPrompts.length === 1 && modernPrompts.length === 1 && modernPrompts[0] === "Allow stub__plain to run?\n\nArguments:\n{}", JSON.stringify(modernPrompts));
    check("the prompt shows invisible characters in the arguments as escapes", legacyPrompts[0]?.includes(String.raw`ok\u202e\u{e0072}`) === true, JSON.stringify(legacyPrompts[0]));

    await writeFile(h.clientFile, JSON.stringify({ mcpServers: { stub: server({ tools: { plain: "never" } }) } }));
    const disabled = "Tool stub__plain is disabled by policy";
    check("a policy edit applies to both clients without a restart", await until(async () => (await stubText(a, "plain")).includes(disabled) && (await stubText(b, "plain")).includes(disabled), 15_000));

    await writeFile(h.clientFile, "{ not json");
    check("a broken edit shows in both clients' logs", await until(() => a.stderr().includes("failed to reload config") && b.stderr().includes("failed to reload config"), 15_000));
    check("the manager log shows it too", (await h.daemonLog()).includes("failed to reload config"));
    check("both clients keep the last config", (await stubText(a, "plain")).includes(disabled) && (await stubText(b, "plain")).includes(disabled));
    const c = await h.bridge();
    check("a client starting meanwhile says the file's servers come from the manager", await until(() => c.stderr().includes("this client gets that file's servers only if the manager already has them"), 10_000), c.stderr().slice(-300));
    const first = await stubText(c, "plain");
    check("and its first call reaches the server the manager has", first.includes(disabled), first);
  } finally {
    await h.cleanUp();
    await rm(scratch, { recursive: true, force: true });
  }
}

async function bridgeConfigReload(): Promise<void> {
  console.log("\n# edits to config.json applied by the manager for every client");
  const scratch = await mkdtemp("/tmp/cbe-e2e-owned-");
  const otherDir = await mkdtemp("/tmp/cbe-e2e-other-");
  const stub = join(scratch, "stub.cjs");
  await writeFile(stub, STUB_STDIO_SERVER);
  const server = { command: process.execPath, args: [stub] };
  const h = await home({ stub: server });
  const configJson = join(h.dir, ".crabeye-mcp-bridge", "config.json");
  const otherFile = join(otherDir, "other.json");
  const owned = (extra: { configPaths?: string[]; servers?: Record<string, unknown>; toolPolicy?: string } = {}) =>
    writeFile(configJson, JSON.stringify({ configPaths: extra.configPaths ?? [h.clientFile], servers: extra.servers, _bridge: { logLevel: "debug", daemon: { killGraceMs: 0, idleMs: 1_500 }, toolPolicy: extra.toolPolicy } }));
  const textFrom = async (bridge: Bridge, name: string) => textOf(await bridge.client.callTool({ name: "run_tool", arguments: { name: `${name}__plain`, arguments: {} } }));
  const bothRun = (bridges: Bridge[], name: string) => until(async () => (await Promise.all(bridges.map((b) => textFrom(b, name)))).every((t) => t === "called plain"), 15_000);
  try {
    const a = await h.bridge();
    const b = await h.bridge({ modern: true });
    check("both clients run stub__plain", await bothRun([a, b], "stub"));

    await owned({ servers: { added: server } });
    check("a server added to config.json reaches both clients without a restart", await bothRun([a, b], "added"));

    await writeFile(otherFile, JSON.stringify({ mcpServers: { more: server } }));
    await owned({ configPaths: [h.clientFile, otherFile], servers: { added: server } });
    check("a client file added to the list in config.json reaches both clients", await bothRun([a, b], "more"));

    await writeFile(otherFile, JSON.stringify({ mcpServers: { more: server, extra: server } }));
    check("an edit to that newly listed file applies without a client starting", await bothRun([a, b], "extra"));

    await writeFile(configJson, "{ not json");
    check("a broken config.json shows in both clients' logs", await until(() => a.stderr().includes("failed to reload config") && b.stderr().includes("failed to reload config"), 15_000));
    check("both clients keep the last config", await bothRun([a, b], "added"));

    await owned({ configPaths: [h.clientFile, otherFile], toolPolicy: "never" });
    const disabled = "Tool stub__plain is disabled by policy";
    check("fixing config.json applies, here disabling every tool for both clients", await until(async () => (await textFrom(a, "stub")) === disabled && (await textFrom(b, "stub")) === disabled, 15_000));
    check("and the server it dropped is gone for both", (await textFrom(a, "added")).includes("not found") && (await textFrom(b, "added")).includes("not found"), await textFrom(a, "added"));
  } finally {
    await h.cleanUp();
    await rm(scratch, { recursive: true, force: true });
    await rm(otherDir, { recursive: true, force: true });
  }
}

try {
  await policyAndReload();
  await bridgeConfigReload();
  await sharedAuth();
  await noManager();
  await beside130();
  await stdioShared();
  await stdioRespawn();
  await stdioBeside130();
  await searchAndLimits();
} catch (err) {
  check("no unexpected error", false, err instanceof Error ? err.stack ?? err.message : String(err));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
