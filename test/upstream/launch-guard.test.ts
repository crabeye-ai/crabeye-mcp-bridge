import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { UPSTREAM_MARKER_ENV } from "../../src/constants.js";
import { readParentPid } from "../../src/process/process-utils.js";
import { launchedByAnotherBridge } from "../../src/upstream/launch-guard.js";
import { AttachedBridge, fixtureSource, servingConfigs, spawnTestManager, stubServerFile, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";

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

  it.skipIf(process.platform === "win32")("marks every child the daemon starts with the daemon's pid, overriding the server's env and the client's", async () => {
    const stub = await stubServerFile();
    onTestFinished(() => stub.cleanup());
    fx = await spawnTestManager({
      manager: { childPingMs: 0, ...servingConfigs({ [fixtureSource.path]: { svc: { command: process.execPath, args: [stub.path], env: { [UPSTREAM_MARKER_ENV]: "" } } } }) },
    });
    const bridge = await AttachedBridge.attach(fx, { childEnv: { ...(process.env as Record<string, string>), [UPSTREAM_MARKER_ENV]: "1" } });
    onTestFinished(() => bridge.close());
    await bridge.connected("svc");

    const env = JSON.parse((await bridge.calledText("svc", "env"))!) as Record<string, string>;

    expect(env[UPSTREAM_MARKER_ENV]).toBe(String(process.pid));
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

});
