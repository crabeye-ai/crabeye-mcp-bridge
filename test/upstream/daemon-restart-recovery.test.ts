import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { StatusResult } from "../../src/daemon/protocol.js";
import { DaemonStdioClient } from "../../src/upstream/daemon-stdio-client.js";
import { spawnTestManager, until, type DaemonFixture } from "../_helpers/daemon-fixtures.js";

const STUB = resolve(fileURLToPath(import.meta.url), "..", "..", "fixtures", "stub-mcp-child.mjs");

describe.skipIf(process.platform === "win32")("a bridge whose upstream is restarted by the daemon", { timeout: 30_000 }, () => {
  let fx: DaemonFixture | undefined;
  let client: DaemonStdioClient | undefined;

  afterEach(async () => {
    await client?.close().catch(() => {});
    await fx?.stop();
    client = undefined;
    fx = undefined;
  });

  async function children(f: DaemonFixture): Promise<StatusResult["children"]> {
    return ((await f.client.call("STATUS")) as StatusResult).children;
  }

  async function echoSucceeds(c: DaemonStdioClient): Promise<boolean> {
    try {
      const result = await c.callTool({ name: "echo", arguments: { text: "hi" } });
      return result.isError !== true;
    } catch {
      return false;
    }
  }

  it("reconnects onto a fresh child and its next tool call succeeds", async () => {
    const f = (fx = await spawnTestManager({ manager: { childPingMs: 0 } }));
    const c = (client = new DaemonStdioClient({
      name: "local",
      config: { command: process.execPath, args: [STUB], _bridge: { sharing: "dedicated" } } as never,
      resolvedEnv: {},
      reconnectBaseDelay: 50,
      reconnectMaxDelay: 200,
      _socketPath: f.socketPath,
      _ensureDaemon: async () => {},
    }));
    await c.connect();
    expect(await echoSucceeds(c)).toBe(true);
    const [before] = await children(f);
    let disconnected = false;
    let reconnected = false;
    c.onStatusChange((event) => {
      if (event.current !== "connected") disconnected = true;
      else if (disconnected) reconnected = true;
    });

    await f.client.call("RESTART", { upstreamHash: before!.upstreamHash });
    await until(() => reconnected, 5_000);

    expect(await echoSucceeds(c)).toBe(true);

    const after = await children(f);
    expect(after).toHaveLength(1);
    expect(after[0]!.pid).not.toBe(before!.pid);
  });
});
