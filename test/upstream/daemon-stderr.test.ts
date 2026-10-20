import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonStdioClient } from "../../src/upstream/daemon-stdio-client.js";
import { spawnTestManager, until, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import { spyLogger, type SpyLogger } from "../_helpers/spy-logger.js";
import { STUB_EXIT_ON_TOOLS_LIST_ENV, STUB_STDIO_SERVER } from "../_helpers/stub-stdio-server.js";

describe.skipIf(process.platform === "win32")("a bridge's log of its STDIO server's stderr", { timeout: 30_000 }, () => {
  let fx: DaemonFixture | undefined;
  const clients: DaemonStdioClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})));
    await fx?.stop();
    fx = undefined;
  });

  async function stdioClient(
    logger: SpyLogger,
    { command, env = {} }: { command?: string; env?: Record<string, string> } = {},
  ): Promise<DaemonStdioClient> {
    fx ??= await spawnTestManager({ manager: { childPingMs: 0 } });
    const stub = join(fx.dir, "stub.cjs");
    await writeFile(stub, STUB_STDIO_SERVER);
    const client = new DaemonStdioClient({
      name: "github",
      config: (command === undefined ? { command: process.execPath, args: [stub] } : { command, args: [] }) as never,
      resolvedEnv: env,
      reconnectBaseDelay: 50,
      reconnectMaxDelay: 200,
      _socketPath: fx.socketPath,
      _ensureDaemon: async () => {},
      logger,
    });
    clients.push(client);
    return client;
  }

  async function connectedClient(logger: SpyLogger): Promise<DaemonStdioClient> {
    const client = await stdioClient(logger);
    await client.connect();
    return client;
  }

  const CRASH_MESSAGE = "STDIO server exited with code 5";
  const loggedCalls = (log: SpyLogger["debug"], message: string) => log.mock.calls.filter(([logged]) => logged === message);

  it("logs each stderr line at debug level only, in every bridge on the shared server", async () => {
    const first = spyLogger();
    const second = spyLogger();
    const a = await connectedClient(first);
    await connectedClient(second);

    const line = "rate limited, retrying in 2s";
    await a.callTool({ name: "stderr", arguments: { text: line } });

    await until(() => [first, second].every((logger) => loggedCalls(logger.debug, line).length > 0));
    for (const logger of [first, second]) {
      expect(loggedCalls(logger.debug, line)).toEqual([[line]]);
      expect(loggedCalls(logger.info, line)).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });

  it("warns in every attached bridge when the server exits, with its last stderr lines", async () => {
    const first = spyLogger();
    const second = spyLogger();
    const a = await connectedClient(first);
    await connectedClient(second);

    await a.callTool({ name: "crash", arguments: { lines: ["Error: invalid credentials"], code: 4 } }).catch(() => {});

    const warning = ["STDIO server exited with code 4", { stderr: ["Error: invalid credentials"] }];
    await until(() => first.warn.mock.calls.length > 0 && second.warn.mock.calls.length > 0);
    expect(first.warn.mock.calls).toEqual([warning]);
    expect(second.warn.mock.calls).toEqual([warning]);
  });

  async function crashAndReconnect(client: DaemonStdioClient, logger: SpyLogger, stops: number): Promise<void> {
    await client.callTool({ name: "crash", arguments: { lines: ["Error: lost connection to database"], code: 5 } }).catch(() => {});
    await until(() => loggedCalls(logger.warn, CRASH_MESSAGE).length + loggedCalls(logger.debug, CRASH_MESSAGE).length === stops);
    await until(async () => (await client.callTool({ name: "plain", arguments: {} }).catch(() => null)) !== null);
  }

  it("warns again for the same crash once the server has reconnected in between", async () => {
    const logger = spyLogger();
    const client = await connectedClient(logger);

    await crashAndReconnect(client, logger, 1);
    await crashAndReconnect(client, logger, 2);

    const warning = [CRASH_MESSAGE, { stderr: ["Error: lost connection to database"] }];
    expect(loggedCalls(logger.warn, CRASH_MESSAGE)).toEqual([warning, warning]);
    expect(loggedCalls(logger.debug, CRASH_MESSAGE)).toEqual([]);
  });

  it("warns once when a command can't be started, then logs the same failure at debug while it keeps retrying", async () => {
    const logger = spyLogger();
    fx = await spawnTestManager({ manager: { childPingMs: 0 } });
    const command = join(fx.dir, "no-such-server");
    const client = await stdioClient(logger, { command });
    const message = "STDIO server could not be started";
    const failure = [message, { stderr: [`spawn ${command} ENOENT`] }];

    void client.connect().catch(() => {});

    await until(() => loggedCalls(logger.debug, message).length >= 2);
    expect(loggedCalls(logger.warn, message)).toEqual([failure]);
    expect(loggedCalls(logger.debug, message)[0]).toEqual(failure);
  });

  it("counts a server that starts but exits while listing its tools as not connected, logging repeats at debug", async () => {
    const logger = spyLogger();
    const client = await stdioClient(logger, { env: { [STUB_EXIT_ON_TOOLS_LIST_ENV]: "1" } });
    const message = "STDIO server exited with code 4";

    void client.connect().catch(() => {});

    await until(() => loggedCalls(logger.debug, message).length >= 2);
    expect(loggedCalls(logger.warn, message)).toEqual([[message, { stderr: ["Error: cannot list tools"] }]]);
  });
});
