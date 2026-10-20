import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";
import { until } from "../_helpers/daemon-fixtures.js";
import { STUB_STARTUP_ERROR_ENV } from "../_helpers/stub-stdio-server.js";
import { CALLED, callStubTool, scratchHome, type BridgeProcess, type ScratchHome } from "../_helpers/bridge-process.js";

const isWindows = process.platform === "win32";
const BACKSLASH = String.fromCharCode(92);

describe.skipIf(isWindows)("STDIO server stderr in the bridge log", { timeout: 60_000 }, () => {
  let cliScript: string;
  let home: ScratchHome;

  beforeAll(async () => {
    cliScript = await bundleForSubprocess("src/index.ts", "cli-stderr");
  });

  afterEach(async () => {
    await home.cleanUp();
  }, 30_000);

  async function bridges(count: number, config: Parameters<typeof scratchHome>[1] = {}): Promise<BridgeProcess[]> {
    home = await scratchHome(() => [cliScript], config);
    const connected: BridgeProcess[] = [];
    for (let i = 0; i < count; i++) connected.push(await home.connectBridge(cliScript));
    for (const bridge of connected) expect(await callStubTool(bridge)).toEqual(CALLED);
    return connected;
  }

  const logged = (bridge: BridgeProcess, text: string) => until(() => bridge.stderr().includes(text), 15_000);

  it("logs a stderr line at debug level in every bridge using the server, tagged and with control characters escaped", async () => {
    const [a, b] = await bridges(2, { bridge: { logLevel: "debug" } });
    const line = `token ${String.fromCodePoint(0x1b)}[31mexpired${String.fromCodePoint(0x2028)}refreshing`;

    await callStubTool(a!, "stderr", { text: line });

    const expected = `DEBUG [upstream:stub] token ${BACKSLASH}x1b[31mexpired${BACKSLASH}u2028refreshing`;
    await logged(a!, expected);
    await logged(b!, expected);
    expect(a!.stderr()).not.toContain(String.fromCodePoint(0x1b));
    expect(a!.stderr()).not.toContain(String.fromCodePoint(0x2028));
  });

  it("keeps routine stderr out of the default log level, and warns in every bridge with the last lines when the server crashes", async () => {
    const [a, b] = await bridges(2);

    await callStubTool(a!, "stderr", { text: "routine progress note" });
    await callStubTool(a!, "crash", { lines: ["Error: upstream API returned 500"], code: 3 }).catch(() => {});

    const warning = `WARN  [upstream:stub] STDIO server exited with code 3 stderr=["routine progress note","Error: upstream API returned 500"]`;
    await logged(a!, warning);
    await logged(b!, warning);
    expect(a!.stderr()).not.toContain("[upstream:stub] routine progress note");
  });

  it("shows why a server that fails at startup stopped, at the default log level", async () => {
    home = await scratchHome(() => [cliScript], { stubEnv: { [STUB_STARTUP_ERROR_ENV]: "Error: GITHUB_TOKEN is not set" } });
    const bridge = await home.connectBridge(cliScript);

    await logged(bridge, `WARN  [upstream:stub] STDIO server exited with code 1 stderr=["Error: GITHUB_TOKEN is not set"]`);
  });
});
