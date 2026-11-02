import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR, DAEMON_DIR } from "../../src/constants.js";
import { bundleForSubprocess } from "../_helpers/subprocess-bundle.js";

describe("a bridge started on a config that doesn't load", { timeout: 60_000 }, () => {
  let cli: string;
  let home: string;

  beforeAll(async () => {
    cli = await bundleForSubprocess("src/index.ts", "cli-startup-config-errors");
  }, 120_000);

  afterEach(async () => {
    await chmod(join(home, CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME), 0o600).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });

  /** A fresh home holding `files`, given relative to it, with `$HOME` in their bodies replaced by it. */
  async function homeWith(files: Record<string, string>): Promise<void> {
    home = await mkdtemp(join(tmpdir(), "cbe-startup-"));
    for (const [path, body] of Object.entries(files)) {
      await mkdir(dirname(join(home, path)), { recursive: true });
      await writeFile(join(home, path), body.replaceAll("$HOME", home));
    }
  }

  /** Runs the bridge in `home`, with `$HOME` in `args` replaced by it. */
  function run(args: string[] = []): { status: number | null; stderr: string } {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
    delete env.MCP_BRIDGE_CONFIG;
    const result = spawnSync(process.execPath, [cli, ...args.map((arg) => arg.replace("$HOME", home))], { env, input: "", encoding: "utf8", timeout: 30_000 });
    return { status: result.status, stderr: result.stderr };
  }

  const CONFIG_JSON = join(CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME);

  it("prints why a --config file doesn't validate and exits 1, without starting the manager", async () => {
    await homeWith({ "bad.json": JSON.stringify({ mcpServers: 5 }) });

    const { status, stderr } = run(["--config", "$HOME/bad.json"]);

    expect([status, stderr]).toEqual([1, "Error: Config validation failed\n  mcpServers: Invalid input: expected record, received number\n"]);
    expect(existsSync(join(home, DAEMON_DIR))).toBe(false);
  });

  it.each([
    ["isn't JSON", "{ not json", (path: string) => `Error: Invalid JSON in config file: ${path}\n`],
    ["has an invalid entry", JSON.stringify({ configPaths: 5 }), () => "Error: Config validation failed\n  configPaths: Invalid input: expected array, received number\n"],
  ])("prints a config error, not a stack trace, when config.json %s, and exits 1", async (_case, body, message) => {
    await homeWith({ [CONFIG_JSON]: body });

    const { status, stderr } = run();

    expect([status, stderr]).toEqual([1, message(join(home, CONFIG_JSON))]);
    expect(existsSync(join(home, DAEMON_DIR))).toBe(false);
  });

  it("starts without a client config file config.json lists that isn't JSON, warning that it gets that file's servers only if the manager already has them", async () => {
    await homeWith({ [CONFIG_JSON]: JSON.stringify({ configPaths: ["$HOME/broken.json"] }), "broken.json": "{ not json" });

    const { status, stderr } = run();

    expect(status).toBe(0);
    expect(stderr).toContain(`Invalid JSON in config file: ${join(home, "broken.json")}; this client gets that file's servers only if the manager already has them`);
  });

  it("lists a client config file config.json lists that isn't JSON when validating", async () => {
    await homeWith({ [CONFIG_JSON]: JSON.stringify({ configPaths: ["$HOME/broken.json"] }), "broken.json": "{ not json" });

    const { status, stderr } = run(["--validate"]);

    expect(status).toBe(0);
    expect(stderr).toContain(`  Invalid JSON in config file: ${join(home, "broken.json")}; its servers are left out\n`);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("prints a config error when config.json can't be read, and exits 1", async () => {
    await homeWith({ [CONFIG_JSON]: "{}" });
    await chmod(join(home, CONFIG_JSON), 0o000);

    const { status, stderr } = run();

    expect([status, stderr]).toEqual([1, `Error: Failed to read config file: ${join(home, CONFIG_JSON)} (EACCES)\n`]);
    expect(existsSync(join(home, DAEMON_DIR))).toBe(false);
  });
});
