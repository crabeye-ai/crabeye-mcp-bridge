import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "jsonc-parser";
import { discoverMcpConfigs } from "../src/config/discovery.js";

function tmp(): string {
  return join(
    tmpdir(),
    `crabeye-init-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

interface ParsedConfig {
  mcpServers?: Record<string, unknown>;
  upstreamMcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readJson(path: string): ParsedConfig {
  return parse(readFileSync(path, "utf-8")) as ParsedConfig;
}

const CLINE_FIXTURE = {
  mcpServers: {
    existing: { command: "node", args: ["./existing.js"] },
  },
};

const ROO_FIXTURE = {
  mcpServers: {
    notion: {
      command: "npx",
      args: ["-y", "@notion/mcp"],
      env: { NOTION_TOKEN: "x" },
      alwaysAllow: ["read"],
      disabled: false,
    },
  },
};

const OPENCODE_FIXTURE = {
  $schema: "https://opencode.ai/config.json",
  mcp: {
    "my-server": {
      type: "local",
      command: ["node", "./server.js"],
      enabled: true,
    },
  },
};

type Entry = { clientName: string; path: string; mode: "inject" | "detect-only" };

const DISCOVERY_MOD = "../src/config/discovery.js";
const CHECKBOX_MOD = "@inquirer/checkbox";
const CONFIRM_MOD = "@inquirer/confirm";
const INIT_MOD = "../src/commands/init.js";

async function runInitWith(
  entries: Entry[],
  selectedPaths: string[] = entries.map((e) => e.path),
  injectConfirm = true,
): Promise<{
  confirmMock: ReturnType<typeof vi.fn>;
  checkboxMock: ReturnType<typeof vi.fn>;
}> {
  vi.resetModules();
  vi.doMock(DISCOVERY_MOD, async () => {
    const actual = await vi.importActual<typeof import("../src/config/discovery.js")>(
      DISCOVERY_MOD,
    );
    return {
      ...actual,
      discoverMcpConfigs: vi.fn().mockResolvedValue(entries),
    };
  });
  const checkboxMock = vi.fn().mockResolvedValue(selectedPaths);
  vi.doMock(CHECKBOX_MOD, () => ({ default: checkboxMock }));
  const confirmMock = vi.fn().mockResolvedValue(injectConfirm);
  vi.doMock(CONFIRM_MOD, () => ({ default: confirmMock }));

  const { runInit } = await import(INIT_MOD);
  await runInit();
  return { confirmMock, checkboxMock };
}

async function runRestoreWith(confirmAnswer = true): Promise<void> {
  vi.resetModules();
  vi.doMock(CONFIRM_MOD, () => ({
    default: vi.fn().mockResolvedValue(confirmAnswer),
  }));
  const { runRestore } = await import("../src/commands/restore.js");
  await runRestore();
}

describe("discoverMcpConfigs (locations overload)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = tmp();
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns only entries whose path exists", async () => {
    const present = join(dir, "present.json");
    const absent = join(dir, "absent.json");
    await writeFile(present, "{}");

    const found = await discoverMcpConfigs([
      { clientName: "Present", paths: [present], mode: "inject" },
      { clientName: "Absent", paths: [absent], mode: "inject" },
    ]);

    expect(found).toEqual([
      { clientName: "Present", path: present, mode: "inject" },
    ]);
  });

  it("picks the first existing path per client", async () => {
    const preferred = join(dir, "preferred.json");
    const fallback = join(dir, "fallback.json");
    await writeFile(fallback, "{}");

    const found = await discoverMcpConfigs([
      { clientName: "Roo Code", paths: [preferred, fallback], mode: "inject" },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]?.path).toBe(fallback);
  });

  it("preserves mode on discovered entries", async () => {
    const p = join(dir, "x.json");
    await writeFile(p, "{}");
    const found = await discoverMcpConfigs([
      { clientName: "X", paths: [p], mode: "detect-only" },
    ]);
    expect(found[0]?.mode).toBe("detect-only");
  });

  it("accepts a directory when acceptDirectory is true", async () => {
    const d = join(dir, "mcpServers");
    await mkdir(d);
    const found = await discoverMcpConfigs([
      {
        clientName: "Continue.dev",
        paths: [d],
        mode: "detect-only",
        acceptDirectory: true,
      },
    ]);
    expect(found).toHaveLength(1);
    expect((await stat(found[0]!.path)).isDirectory()).toBe(true);
  });

  it("Roo Code: falls back to cline_mcp_settings.json when mcp_settings.json is absent", async () => {
    const settingsDir = join(dir, "roo-settings");
    await mkdir(settingsDir, { recursive: true });
    const legacy = join(settingsDir, "cline_mcp_settings.json");
    await writeFile(legacy, JSON.stringify(ROO_FIXTURE));

    const found = await discoverMcpConfigs([
      {
        clientName: "Roo Code",
        paths: [
          join(settingsDir, "mcp_settings.json"),
          legacy,
        ],
        mode: "inject",
      },
    ]);
    expect(found).toEqual([
      { clientName: "Roo Code", path: legacy, mode: "inject" },
    ]);
  });

  it("Continue.dev: detects config.yaml when only the YAML file exists", async () => {
    const continueDir = join(dir, "continue");
    await mkdir(continueDir, { recursive: true });
    const yamlPath = join(continueDir, "config.yaml");
    await writeFile(yamlPath, "models: []\n");

    const found = await discoverMcpConfigs([
      {
        clientName: "Continue.dev",
        paths: [
          join(continueDir, "config.json"),
          yamlPath,
          join(continueDir, "mcpServers"),
        ],
        mode: "detect-only",
        acceptDirectory: true,
      },
    ]);
    expect(found).toEqual([
      { clientName: "Continue.dev", path: yamlPath, mode: "detect-only" },
    ]);
  });

  it("ignores a directory when acceptDirectory is false (default)", async () => {
    const d = join(dir, "mcpServers");
    await mkdir(d);
    const found = await discoverMcpConfigs([
      { clientName: "Strict", paths: [d], mode: "inject" },
    ]);
    expect(found).toEqual([]);
  });
});

describe("runInit", () => {
  let dir: string;
  let bridgeHome: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  let stderr: string;

  beforeEach(async () => {
    dir = tmp();
    bridgeHome = tmp();
    await mkdir(dir, { recursive: true });
    await mkdir(bridgeHome, { recursive: true });
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = bridgeHome;
    process.env.USERPROFILE = bridgeHome;
    stderr = "";
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock(DISCOVERY_MOD);
    vi.doUnmock(CHECKBOX_MOD);
    vi.doUnmock(CONFIRM_MOD);
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
    await rm(dir, { recursive: true, force: true });
    await rm(bridgeHome, { recursive: true, force: true });
  });

  describe("inject (Cline / Roo Code)", () => {
    it("Cline: renames mcpServers → upstreamMcpServers and inserts bridge entry", async () => {
      const configPath = join(dir, "cline_mcp_settings.json");
      await writeFile(configPath, JSON.stringify(CLINE_FIXTURE, null, 2) + "\n");

      await runInitWith([{ clientName: "Cline", path: configPath, mode: "inject" }]);

      const after = readJson(configPath);
      expect(after.upstreamMcpServers).toEqual({
        existing: { command: "node", args: ["./existing.js"] },
      });
      expect(after.mcpServers).toEqual({
        "crabeye-mcp-bridge": {
          command: "npx",
          args: ["-y", "@crabeye-ai/crabeye-mcp-bridge"],
        },
      });
    });

    it("Roo Code: preserves Roo-specific extra fields under upstreamMcpServers", async () => {
      const configPath = join(dir, "mcp_settings.json");
      await writeFile(configPath, JSON.stringify(ROO_FIXTURE, null, 2) + "\n");

      await runInitWith([{ clientName: "Roo Code", path: configPath, mode: "inject" }]);

      const after = readJson(configPath);
      const upstream = after.upstreamMcpServers as Record<string, Record<string, unknown>>;
      expect(upstream.notion).toEqual({
        command: "npx",
        args: ["-y", "@notion/mcp"],
        env: { NOTION_TOKEN: "x" },
        alwaysAllow: ["read"],
        disabled: false,
      });
    });

    it("self-exclusion no-ops when bridge entry already present", async () => {
      const fixture = {
        mcpServers: {
          "crabeye-mcp-bridge": {
            command: "npx",
            args: ["-y", "@crabeye-ai/crabeye-mcp-bridge"],
          },
          other: { command: "node", args: ["./o.js"] },
        },
      };
      const configPath = join(dir, "cline_mcp_settings.json");
      await writeFile(configPath, JSON.stringify(fixture, null, 2) + "\n");

      await runInitWith([{ clientName: "Cline", path: configPath, mode: "inject" }]);

      const after = readJson(configPath);
      expect(after.upstreamMcpServers).toBeUndefined();
      expect(after.mcpServers).toEqual(fixture.mcpServers);
      expect(stderr).toContain("already present");
    });

    it("empty config falls through to add-only path", async () => {
      const configPath = join(dir, "cline_mcp_settings.json");
      await writeFile(configPath, JSON.stringify({ unrelated: 42 }, null, 2) + "\n");

      await runInitWith([{ clientName: "Cline", path: configPath, mode: "inject" }]);

      const after = readJson(configPath);
      expect(after.unrelated).toBe(42);
      expect(after.mcpServers).toEqual({
        "crabeye-mcp-bridge": {
          command: "npx",
          args: ["-y", "@crabeye-ai/crabeye-mcp-bridge"],
        },
      });
      expect(after.upstreamMcpServers).toBeUndefined();
    });

    it("Cline restore round-trips back to a config equivalent to the original", async () => {
      const configPath = join(dir, "cline_mcp_settings.json");
      const before = JSON.parse(JSON.stringify(CLINE_FIXTURE));
      await writeFile(configPath, JSON.stringify(before, null, 2) + "\n");

      await runInitWith([{ clientName: "Cline", path: configPath, mode: "inject" }]);
      expect(readJson(configPath).upstreamMcpServers).toBeDefined();
      const bridgeConfigPath = join(bridgeHome, ".crabeye-mcp-bridge", "config.json");
      expect(existsSync(bridgeConfigPath)).toBe(true);

      await runRestoreWith(true);

      const after = readJson(configPath);
      expect(after.upstreamMcpServers).toBeUndefined();
      expect(after.mcpServers).toEqual(before.mcpServers);
      // With confirm=true for both prompts, the bridge config is deleted.
      expect(existsSync(bridgeConfigPath)).toBe(false);
    });

    it("Roo Code restore preserves alwaysAllow / disabled / env on the upstream entry", async () => {
      const configPath = join(dir, "mcp_settings.json");
      const before = JSON.parse(JSON.stringify(ROO_FIXTURE));
      await writeFile(configPath, JSON.stringify(before, null, 2) + "\n");

      await runInitWith([{ clientName: "Roo Code", path: configPath, mode: "inject" }]);
      await runRestoreWith(true);

      const after = readJson(configPath);
      expect(after.upstreamMcpServers).toBeUndefined();
      expect(after.mcpServers).toEqual(before.mcpServers);
    });

    it("preserves unrelated top-level keys", async () => {
      const fixture = {
        ...CLINE_FIXTURE,
        _someOtherKey: { nested: { keep: true } },
      };
      const configPath = join(dir, "cline_mcp_settings.json");
      await writeFile(configPath, JSON.stringify(fixture, null, 2) + "\n");

      await runInitWith([{ clientName: "Cline", path: configPath, mode: "inject" }]);

      const after = readJson(configPath);
      expect(after._someOtherKey).toEqual({ nested: { keep: true } });
    });

    it("injects multiple inject-mode configs in one run", async () => {
      const clinePath = join(dir, "cline_mcp_settings.json");
      const cursorPath = join(dir, "cursor_mcp.json");
      await writeFile(clinePath, JSON.stringify(CLINE_FIXTURE, null, 2) + "\n");
      await writeFile(cursorPath, JSON.stringify(CLINE_FIXTURE, null, 2) + "\n");

      await runInitWith([
        { clientName: "Cline", path: clinePath, mode: "inject" },
        { clientName: "Cursor", path: cursorPath, mode: "inject" },
      ]);

      for (const p of [clinePath, cursorPath]) {
        const after = readJson(p);
        expect(after.upstreamMcpServers).toEqual({
          existing: { command: "node", args: ["./existing.js"] },
        });
        expect((after.mcpServers as Record<string, unknown>)["crabeye-mcp-bridge"]).toBeDefined();
      }

      const bridgeConfigPath = join(bridgeHome, ".crabeye-mcp-bridge", "config.json");
      const saved = JSON.parse(await readFile(bridgeConfigPath, "utf-8")) as {
        modifiedConfigs: string[];
      };
      expect(saved.modifiedConfigs.sort()).toEqual([clinePath, cursorPath].sort());
    });

    it("logs and continues when one config read throws", async () => {
      const goodPath = join(dir, "cline_mcp_settings.json");
      const badPath = join(dir, "vanished.json");
      await writeFile(goodPath, JSON.stringify(CLINE_FIXTURE, null, 2) + "\n");
      // badPath deliberately doesn't exist — readFile will throw ENOENT.

      await runInitWith([
        { clientName: "Cursor", path: badPath, mode: "inject" },
        { clientName: "Cline", path: goodPath, mode: "inject" },
      ]);

      // Good path was still transformed.
      expect((readJson(goodPath).mcpServers as Record<string, unknown>)["crabeye-mcp-bridge"]).toBeDefined();
      // Error was surfaced.
      expect(stderr).toContain("Failed to update");

      const bridgeConfigPath = join(bridgeHome, ".crabeye-mcp-bridge", "config.json");
      const saved = JSON.parse(await readFile(bridgeConfigPath, "utf-8")) as {
        modifiedConfigs: string[];
      };
      expect(saved.modifiedConfigs).not.toContain(badPath);
      expect(saved.modifiedConfigs).toContain(goodPath);
    });

    it("preserves prior modifiedConfigs entries across re-init", async () => {
      const oldPath = "/nonexistent/old-cline.json";
      const newPath = join(dir, "cline_mcp_settings.json");
      await writeFile(newPath, JSON.stringify(CLINE_FIXTURE, null, 2) + "\n");

      const bridgeConfigDir = join(bridgeHome, ".crabeye-mcp-bridge");
      await mkdir(bridgeConfigDir, { recursive: true });
      await writeFile(
        join(bridgeConfigDir, "config.json"),
        JSON.stringify({ configPaths: [oldPath], modifiedConfigs: [oldPath] }, null, 2) + "\n",
      );

      await runInitWith([{ clientName: "Cline", path: newPath, mode: "inject" }]);

      const saved = JSON.parse(
        await readFile(join(bridgeConfigDir, "config.json"), "utf-8"),
      ) as { configPaths: string[]; modifiedConfigs: string[] };
      // configPaths is replaced wholesale (existing behavior).
      expect(saved.configPaths).toEqual([newPath]);
      // modifiedConfigs is additive — the historical entry survives.
      expect(saved.modifiedConfigs).toContain(oldPath);
      expect(saved.modifiedConfigs).toContain(newPath);
    });

    it("confirm=false: writes configPaths but leaves selected files untouched", async () => {
      const configPath = join(dir, "cline_mcp_settings.json");
      const original = JSON.stringify(CLINE_FIXTURE, null, 2) + "\n";
      await writeFile(configPath, original);

      await runInitWith(
        [{ clientName: "Cline", path: configPath, mode: "inject" }],
        [configPath],
        false,
      );

      expect(await readFile(configPath, "utf-8")).toBe(original);
      const bridgeConfigPath = join(bridgeHome, ".crabeye-mcp-bridge", "config.json");
      const saved = JSON.parse(await readFile(bridgeConfigPath, "utf-8")) as {
        configPaths: string[];
        modifiedConfigs: string[];
      };
      expect(saved.configPaths).toEqual([configPath]);
      expect(saved.modifiedConfigs).toEqual([]);
    });
  });

  describe("detect-only (opencode / Continue.dev)", () => {
    it("opencode: file is untouched and snippet is printed", async () => {
      const configPath = join(dir, "opencode.json");
      const original = JSON.stringify(OPENCODE_FIXTURE, null, 2) + "\n";
      await writeFile(configPath, original);

      await runInitWith([
        { clientName: "opencode", path: configPath, mode: "detect-only" },
      ]);

      expect(await readFile(configPath, "utf-8")).toBe(original);
      expect(stderr).toContain("opencode cannot be auto-injected");
      expect(stderr).toMatch(/"type":\s*"local"/);
      expect(stderr).toMatch(/"command":\s*\[\s*"npx"/);
    });

    it("Continue.dev: file is untouched and link is surfaced", async () => {
      const configPath = join(dir, "config.json");
      const original = JSON.stringify({ models: [] }, null, 2) + "\n";
      await writeFile(configPath, original);

      await runInitWith([
        { clientName: "Continue.dev", path: configPath, mode: "detect-only" },
      ]);

      expect(await readFile(configPath, "utf-8")).toBe(original);
      expect(stderr).toContain("Continue.dev's MCP support is still evolving");
      expect(stderr).toContain("docs.continue.dev");
    });

    it("detect-only only: configPaths empty, snippet still printed, confirm not invoked", async () => {
      const configPath = join(dir, "opencode.json");
      await writeFile(configPath, JSON.stringify(OPENCODE_FIXTURE, null, 2) + "\n");

      const { confirmMock } = await runInitWith([
        { clientName: "opencode", path: configPath, mode: "detect-only" },
      ]);

      expect(stderr).toContain("opencode cannot be auto-injected");
      expect(confirmMock).not.toHaveBeenCalled();
      const bridgeConfigPath = join(bridgeHome, ".crabeye-mcp-bridge", "config.json");
      const saved = JSON.parse(await readFile(bridgeConfigPath, "utf-8")) as {
        configPaths: string[];
        modifiedConfigs: string[];
      };
      expect(saved.configPaths).toEqual([]);
      expect(saved.modifiedConfigs).toEqual([]);
    });

    it("unknown detect-only client falls back to the generic snippet", async () => {
      const configPath = join(dir, "future.json");
      await writeFile(configPath, "{}");

      // "FutureHarness" deliberately matches neither the opencode nor the
      // Continue.dev branches in printDetectOnlySnippet — exercises the fallback.
      await runInitWith([
        { clientName: "FutureHarness", path: configPath, mode: "detect-only" },
      ]);

      expect(stderr).toContain("FutureHarness cannot be auto-injected");
      expect(stderr).toContain("Add an entry pointing at");
    });

    it("detect-only entries get a (detect-only) suffix on the checkbox label", async () => {
      const injectPath = join(dir, "cline_mcp_settings.json");
      const detectPath = join(dir, "opencode.json");
      await writeFile(injectPath, JSON.stringify(CLINE_FIXTURE, null, 2) + "\n");
      await writeFile(detectPath, JSON.stringify(OPENCODE_FIXTURE, null, 2) + "\n");

      const { checkboxMock } = await runInitWith([
        { clientName: "Cline", path: injectPath, mode: "inject" },
        { clientName: "opencode", path: detectPath, mode: "detect-only" },
      ]);

      const callArgs = checkboxMock.mock.calls[0]?.[0] as {
        choices: Array<{ name: string; value: string }>;
      };
      const labels = Object.fromEntries(
        callArgs.choices.map((c) => [c.value, c.name]),
      );
      expect(labels[injectPath]).not.toContain("(detect-only)");
      expect(labels[detectPath]).toContain("(detect-only)");
    });

    it("detect-only snippet prints even when inject confirm is declined", async () => {
      const injectPath = join(dir, "cline_mcp_settings.json");
      const detectPath = join(dir, "opencode.json");
      const original = JSON.stringify(CLINE_FIXTURE, null, 2) + "\n";
      await writeFile(injectPath, original);
      await writeFile(detectPath, JSON.stringify(OPENCODE_FIXTURE, null, 2) + "\n");

      await runInitWith(
        [
          { clientName: "Cline", path: injectPath, mode: "inject" },
          { clientName: "opencode", path: detectPath, mode: "detect-only" },
        ],
        [injectPath, detectPath],
        false,
      );

      // Cline file untouched (confirm=false)
      expect(await readFile(injectPath, "utf-8")).toBe(original);
      // opencode snippet still surfaced
      expect(stderr).toContain("opencode cannot be auto-injected");
      expect(stderr).toContain('"type": "local"');
    });

    it("mixed selection: detect-only paths stay out of configPaths and modifiedConfigs", async () => {
      const injectPath = join(dir, "cline_mcp_settings.json");
      const detectPath = join(dir, "opencode.json");
      await writeFile(injectPath, JSON.stringify(CLINE_FIXTURE, null, 2) + "\n");
      await writeFile(detectPath, JSON.stringify(OPENCODE_FIXTURE, null, 2) + "\n");

      await runInitWith([
        { clientName: "Cline", path: injectPath, mode: "inject" },
        { clientName: "opencode", path: detectPath, mode: "detect-only" },
      ]);

      const bridgeConfigPath = join(bridgeHome, ".crabeye-mcp-bridge", "config.json");
      const saved = JSON.parse(await readFile(bridgeConfigPath, "utf-8")) as {
        configPaths: string[];
        modifiedConfigs: string[];
      };
      expect(saved.configPaths).toEqual([injectPath]);
      expect(saved.modifiedConfigs).toEqual([injectPath]);
    });
  });
});
