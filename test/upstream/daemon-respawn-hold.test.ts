import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { netTransport } from "../../src/daemon/net-transport.js";
import { DaemonStdioClient } from "../../src/upstream/daemon-stdio-client.js";
import { spawnTestManager, until, type DaemonFixture } from "../_helpers/daemon-fixtures.js";

const COUNTING_UPSTREAM = `
  const fs = require("node:fs");
  const log = process.argv[1];
  const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    if (msg.method === "initialize") {
      reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "counting", version: "1" } });
    } else if (msg.method === "tools/list") {
      reply(msg.id, { tools: [{ name: "count", inputSchema: { type: "object" } }] });
    } else if (msg.method === "tools/call") {
      fs.appendFileSync(log, msg.params.arguments.n + "\\n");
      setTimeout(() => reply(msg.id, { content: [{ type: "text", text: String(msg.params.arguments.n) }] }), 300);
    } else {
      reply(msg.id, {});
    }
  });
`;

describe.skipIf(process.platform === "win32")("a bridge calling tools while its daemon is replaced", { timeout: 30_000 }, () => {
  let fx: DaemonFixture | undefined;
  let replacement: ManagerDaemon | undefined;
  let client: DaemonStdioClient | undefined;

  afterEach(async () => {
    await client?.close().catch(() => {});
    await replacement?.stop(0).catch(() => {});
    await fx?.stop();
    client = undefined;
    replacement = undefined;
    fx = undefined;
  });

  function startReplacement(f: DaemonFixture): Promise<void> {
    replacement = new ManagerDaemon({
      socketPath: f.socketPath,
      pidPath: f.pidPath,
      lockPath: f.lockPath,
      idleMs: 60_000,
      childPingMs: 0,
      transport: netTransport,
      processTrackerPath: join(f.dir, "processes.json"),
    });
    return replacement.start();
  }

  async function executions(log: string): Promise<string[]> {
    const text = await readFile(log, "utf-8").catch(() => "");
    return text.split("\n").filter((line) => line.length > 0);
  }

  it("runs each call at most once across the replacement, and serves calls issued after the old daemon is gone", async () => {
    const f = (fx = await spawnTestManager({ manager: { childPingMs: 0 } }));
    const log = join(f.dir, "executions.log");
    let replaced = false;
    let reachedReplacement!: () => void;
    const replacementReached = new Promise<void>((resolve) => (reachedReplacement = resolve));
    let releaseReplacement!: () => void;
    const replacementReleased = new Promise<void>((resolve) => (releaseReplacement = resolve));
    const c = (client = new DaemonStdioClient({
      name: "counting",
      config: { command: process.execPath, args: ["-e", COUNTING_UPSTREAM, log], _bridge: { sharing: "dedicated" } } as never,
      resolvedEnv: {},
      heartbeatMs: 60_000,
      _socketPath: f.socketPath,
      _ensureDaemon: async (opts) => {
        if (opts?.freshAttempt && !replaced) {
          replaced = true;
          reachedReplacement();
          await replacementReleased;
          await startReplacement(f);
        }
      },
    }));
    await c.connect();
    await c.callTool({ name: "count", arguments: { n: 0 } });

    const staggered = Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        new Promise((r) => setTimeout(r, i * 15)).then(() => c.callTool({ name: "count", arguments: { n: i + 1 } })),
      ),
    );
    await until(async () => (await executions(log)).length > 2);
    await f.manager.stop(0);
    await replacementReached;
    const heldUntilReplaced = c.callTool({ name: "count", arguments: { n: 99 } });
    await new Promise((r) => setTimeout(r, 50));
    const ranBeforeReplacement = await executions(log);
    releaseReplacement();
    const afterOldDaemonGone = await heldUntilReplaced;
    const outcomes = await staggered;

    const ran = await executions(log);
    expect(new Set(ran).size).toBe(ran.length);
    expect(ranBeforeReplacement).not.toContain("99");
    expect(afterOldDaemonGone.isError).not.toBe(true);
    expect(ran.filter((n) => n === "99")).toHaveLength(1);
    expect(outcomes.some((outcome) => outcome.status === "rejected")).toBe(true);
    outcomes.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") expect(ran).toContain(String(i + 1));
      else expect(String(outcome.reason)).toMatch(/upstream restarted|daemon shutdown/);
    });
  });
});
