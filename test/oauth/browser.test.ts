import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions } from "node:child_process";

interface Launch {
  command: string;
  args: string[];
  options: SpawnOptions & { env: NodeJS.ProcessEnv };
  child: EventEmitter;
  spawned: Promise<void>;
}

const launches = vi.hoisted(() => [] as Launch[]);

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (command: string, args: string[], options: Launch["options"]) => {
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    const spawned = new Promise<void>((resolve) =>
      setImmediate(() => {
        child.emit("spawn");
        resolve();
      }),
    );
    launches.push({ command, args, options, child, spawned });
    return child;
  },
}));

const { openBrowser } = await import("../../src/oauth/browser.js");
const { windowsPowerShellPath } = await import("../../src/process/process-utils.js");
const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");

const AUTHORIZATION_URL =
  "https://auth.example/authorize?response_type=code&client_id=a&redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&state=x'y&scope=read%20write";

const firstLaunch = (): Launch => launches[0]!;
const aMomentLater = () => new Promise((resolve) => setTimeout(resolve, 10));

async function openOnWindows(url: string, code: number | null, signal: NodeJS.Signals | null = null): Promise<{ opened: boolean; launch: Launch }> {
  const opened = openBrowser(url, { _platform: "win32" });
  const launch = firstLaunch();
  await launch.spawned;
  await aMomentLater();
  launch.child.emit("exit", code, signal);
  return { opened: await opened, launch };
}

function recordedWindowsLaunch(url: string): Launch {
  void openBrowser(url, { _platform: "win32" });
  return firstLaunch();
}

describe("openBrowser", () => {
  beforeEach(() => {
    launches.length = 0;
  });

  it("starts PowerShell from System32 on Windows, with the URL in its environment and not in its script", async () => {
    const { opened, launch } = await openOnWindows(AUTHORIZATION_URL, 0);

    expect(opened).toBe(true);
    expect(launch.command).toBe(windowsPowerShellPath());
    expect(launch.args).toEqual(["-NoProfile", "-NonInteractive", "-Command", "Start-Process $env:CRABEYE_MCP_BRIDGE_BROWSER_URL"]);
    expect(launch.options.env).toEqual({ ...process.env, CRABEYE_MCP_BRIDGE_BROWSER_URL: AUTHORIZATION_URL });
    expect(launch.options).toMatchObject({ stdio: "ignore", detached: false, windowsHide: true });
  });

  it.each([
    { name: "fails", code: 1, signal: null },
    { name: "is killed", code: null, signal: "SIGTERM" as const },
  ])("reports that the browser didn't open when PowerShell $name on Windows", async ({ code, signal }) => {
    expect((await openOnWindows(AUTHORIZATION_URL, code, signal)).opened).toBe(false);
  });

  it("reports that the browser didn't open when PowerShell can't be started on Windows", async () => {
    const opened = openBrowser(AUTHORIZATION_URL, { _platform: "win32" });
    firstLaunch().child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));

    expect(await opened).toBe(false);
  });

  it.each([
    { platform: "darwin" as const, command: "open" },
    { platform: "linux" as const, command: "xdg-open" },
  ])("starts $command with the URL as its argument on $platform, without waiting for it to exit", async ({ platform, command }) => {
    await expect(openBrowser(AUTHORIZATION_URL, { _platform: platform })).resolves.toBe(true);

    expect(launches.map(({ command, args }) => ({ command, args }))).toEqual([{ command, args: [AUTHORIZATION_URL] }]);
    expect(firstLaunch().options).toMatchObject({ stdio: "ignore", detached: true });
  });

  it.each(["file:///C:/Windows/System32/calc.exe", "https://user:pass@auth.example/authorize", "not a url"])(
    "refuses to open %s without starting anything",
    async (url) => {
      await expect(openBrowser(url, { _platform: "win32" })).resolves.toBe(false);

      expect(launches).toEqual([]);
    },
  );

  it.runIf(process.platform === "win32").each([
    { name: "several parameters and a quote", url: AUTHORIZATION_URL },
    { name: "PowerShell syntax", url: "https://auth.example/a?q=\"x\";$(Get-Date)`n&b=$env:PATH&c=%24%26#frag" },
    { name: "300 parameters", url: `https://auth.example/authorize?${"p=v&".repeat(300)}end=1` },
  ])("gives PowerShell, started as openBrowser starts it, a URL with $name unchanged", { timeout: 30_000 }, async ({ url }) => {
    const launch = recordedWindowsLaunch(url);
    const dir = await mkdtemp(join(tmpdir(), "cbe-browser-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const received = join(dir, "url.txt");
    const recordingArgs = launch.args.map((arg) => arg.replace("Start-Process", () => "Set-Content -LiteralPath $env:CBE_RECEIVED -NoNewline -Value"));
    const env = { ...launch.options.env, CBE_RECEIVED: received };

    const [code] = await once(spawn(launch.command, recordingArgs, { ...launch.options, env }), "exit");

    expect(code).toBe(0);
    expect(await readFile(received, "utf8")).toBe(url);
  });

  it.runIf(process.platform === "win32")(
    "PowerShell started with openBrowser's options exits with code 1 when its command fails on Windows",
    { timeout: 30_000 },
    async () => {
      const launch = recordedWindowsLaunch(AUTHORIZATION_URL);
      const failingArgs = launch.args.map((arg) => arg.replace("Start-Process", "Write-Error"));

      const [code] = await once(spawn(launch.command, failingArgs, launch.options), "exit");

      expect(code).toBe(1);
    },
  );
});
