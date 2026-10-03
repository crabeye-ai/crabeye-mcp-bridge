import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { UPSTREAM_MARKER_ENV } from "../../src/constants.js";
import { readParentPid } from "../../src/process/process-utils.js";
import { launchedByAnotherBridge } from "../../src/upstream/launch-guard.js";
import { OpenSessionFixture, spawnTestManager, until, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";

const ECHO_MARKER = `
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { marker: process.env.${UPSTREAM_MARKER_ENV} ?? null } }) + "\\n");
  });
`;

let cli: string;

beforeAll(async () => {
  cli = await bundleForSubprocess("src/index.ts", "self-reference-cli");
});

async function runCli(args: string[], env: NodeJS.ProcessEnv, config?: unknown): Promise<{ status: number | null; stderr: string }> {
  const home = await mkdtemp(join(tmpdir(), "self-ref-cli-"));
  try {
    const configArgs = [];
    if (config !== undefined) {
      const path = join(home, "config.json");
      await writeFile(path, JSON.stringify(config));
      configArgs.push("--config", path);
    }
    const result = spawnSync(process.execPath, [cli, ...args, ...configArgs], {
      env: { ...process.env, HOME: home, ...env },
      input: "",
      encoding: "utf-8",
      timeout: 20_000,
      cwd: home,
    });
    return { status: result.status, stderr: result.stderr };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("launch guard", () => {
  let fx: DaemonFixture | undefined;

  afterEach(async () => {
    await fx?.stop();
    fx = undefined;
  });

  const chain = (parents: Record<number, number>) => async (pid: number) => parents[pid] ?? null;

  it("refuses only when the daemon named by the marker is an ancestor", async () => {
    const env = { [UPSTREAM_MARKER_ENV]: "500" };

    expect(await launchedByAnotherBridge(env, chain({ 700: 600, 600: 500 }), 700)).toBe(true);
    expect(await launchedByAnotherBridge(env, chain({ 700: 1 }), 700)).toBe(false);
    expect(await launchedByAnotherBridge(env, chain({}), 700)).toBe(false);
  });

  it("ignores a missing or meaningless marker", async () => {
    expect(await launchedByAnotherBridge({}, chain({ 700: 600 }), 700)).toBe(false);
    expect(await launchedByAnotherBridge({ [UPSTREAM_MARKER_ENV]: "1" }, chain({ 700: 1 }), 700)).toBe(false);
    expect(await launchedByAnotherBridge({ [UPSTREAM_MARKER_ENV]: "yes" }, chain({ 700: 600 }), 700)).toBe(false);
  });

  it.skipIf(process.platform === "win32")("marks every child the daemon starts with the daemon's pid, overriding the session's env", async () => {
    fx = await spawnTestManager({ manager: { childPingMs: 0 } });
    const session = await OpenSessionFixture.open(fx, {
      command: process.execPath,
      args: ["-e", ECHO_MARKER],
      resolvedEnv: { [UPSTREAM_MARKER_ENV]: "" },
    });
    session.sendRpc({ jsonrpc: "2.0", id: 1, method: "probe" });

    const reply = (await session.waitForFrame((p) => (p as { id?: unknown }).id === 1, 5_000)) as { result: { marker: unknown } };

    expect(reply.result.marker).toBe(String(process.pid));
    await session.close();
  });

  it("refuses to serve when its ancestor daemon started it", { timeout: 30_000 }, async () => {
    const result = await runCli([], { [UPSTREAM_MARKER_ENV]: String(process.pid) }, { mcpServers: {} });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/started as an upstream of another crabeye-mcp-bridge/);
  });

  it("reads the real parent of a process", async () => {
    expect(await readParentPid(process.pid)).toBe(process.ppid);
  });

  it.skipIf(process.platform === "win32")(
    "refuses when the daemon is a grandparent, even if the server config hides ps from PATH",
    { timeout: 30_000 },
    async () => {
      const home = await mkdtemp(join(tmpdir(), "self-ref-grand-"));
      try {
        const config = join(home, "config.json");
        await writeFile(config, JSON.stringify({ mcpServers: {} }));
        const result = spawnSync("/bin/sh", ["-c", `"${process.execPath}" "${cli}" --config "${config}"; exit $?`], {
          env: { ...process.env, HOME: home, PATH: "/nonexistent", [UPSTREAM_MARKER_ENV]: String(process.pid) },
          input: "",
          encoding: "utf-8",
          timeout: 20_000,
          cwd: home,
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/started as an upstream of another crabeye-mcp-bridge/);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("serves normally when the marker was inherited from an unrelated process", { timeout: 30_000 }, async () => {
    const result = await runCli([], { [UPSTREAM_MARKER_ENV]: "999999" }, { mcpServers: {} });

    expect(result.stderr).not.toMatch(/started as an upstream/);
  });
});

describe("skipped servers on the command line", () => {
  const selfReferencing = {
    mcpServers: { b: { command: "npx", args: ["-y", "crabeye-mcp-bridge"] }, kept: { command: "node", args: ["s.js"] } },
  };

  it("lists them under --validate, even inside another bridge's upstream", { timeout: 30_000 }, async () => {
    const result = await runCli(["--validate"], { [UPSTREAM_MARKER_ENV]: String(process.pid) }, selfReferencing);

    expect(result.status).toBe(0);
    expect(result.stderr.match(/b skipped: it launches crabeye-mcp-bridge itself/g)).toHaveLength(1);
    expect(result.stderr).toMatch(/kept \(stdio\)/);
  });

  it("are not logged by commands that only read the config", { timeout: 30_000 }, async () => {
    const result = await runCli(["auth", "--list"], {}, selfReferencing);

    expect(result.stderr).not.toMatch(/skipping server/);
  });

  it("logs each one once at startup", { timeout: 30_000 }, async () => {
    const result = await runCli([], {}, { mcpServers: { b: selfReferencing.mcpServers.b } });

    expect(result.stderr.match(/skipping server "b": it launches crabeye-mcp-bridge itself/g)).toHaveLength(1);
  });

  async function reload(before: object, after: object, reloaded: string) {
    const home = await mkdtemp(join(tmpdir(), "self-ref-reload-"));
    const config = join(home, "config.json");
    await writeFile(config, JSON.stringify(before));
    const bridge = spawn(process.execPath, [cli, "--config", config], { env: { ...process.env, HOME: home }, cwd: home });
    let stdout = "";
    let stderr = "";
    bridge.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    bridge.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const skipLines = () => stderr.match(/skipping server "b": it launches crabeye-mcp-bridge itself/g)?.length ?? 0;
    try {
      bridge.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "reload-test", version: "1" } },
        }) + "\n",
      );
      await until(() => stdout.includes('"id":1'), 15_000);
      const atStartup = skipLines();
      const write = () => void writeFile(config, JSON.stringify(after)).catch(() => {});
      write();
      const keepWriting = setInterval(write, 1_500);
      try {
        await until(() => stderr.includes(reloaded), 15_000);
      } finally {
        clearInterval(keepWriting);
      }
      await new Promise((r) => setTimeout(r, 500));
      return { atStartup, total: skipLines(), stderr };
    } finally {
      bridge.kill();
      await rm(home, { recursive: true, force: true });
    }
  }

  it.skipIf(process.platform === "win32")("logs them under the new log level when a reload changes it", { timeout: 40_000 }, async () => {
    const b = selfReferencing.mcpServers.b;
    const run = await reload(
      { mcpServers: { b }, _bridge: { logLevel: "warn" } },
      { mcpServers: { b }, _bridge: { logLevel: "info" } },
      "log level changed to info",
    );

    expect(run.atStartup).toBe(0);
    expect(run.total).toBe(1);
    expect(run.stderr).toMatch(/log level changed to info[\s\S]*skipping server "b"/);
  });

  it.skipIf(process.platform === "win32")("logs them again when the config reloads", { timeout: 40_000 }, async () => {
    const b = selfReferencing.mcpServers.b;
    const run = await reload({ mcpServers: { b } }, { mcpServers: { b }, _bridge: { logLevel: "debug" } }, "log level changed to debug");

    expect(run.atStartup).toBe(1);
    expect(run.total).toBe(2);
  });
});
