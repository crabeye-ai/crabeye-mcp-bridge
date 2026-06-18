import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-expect-error — the sync script is a plain ESM .js file with no .d.ts;
// vitest resolves it at runtime via the standard ESM loader.
import { syncPluginVersion } from "../../scripts/sync-plugin-version.js";

function tmp(): string {
  return join(
    tmpdir(),
    `crabeye-sync-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

const baseManifest = {
  name: "crabeye-mcp-bridge",
  version: "1.0.0",
  description: "Test description preserved",
  author: { name: "Crabeye AI" },
  homepage: "https://example.com",
  repository: "https://example.com/repo",
  license: "MIT",
  keywords: ["mcp", "bridge"],
  mcpServers: {
    crabeye: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@crabeye-ai/crabeye-mcp-bridge"],
    },
  },
};

describe("syncPluginVersion", () => {
  let dir: string;
  let pkgPath: string;
  let manifestPath: string;

  beforeEach(async () => {
    dir = tmp();
    await mkdir(dir, { recursive: true });
    pkgPath = join(dir, "package.json");
    manifestPath = join(dir, "plugin.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seed(pkgVersion: string, manifest: object = baseManifest): Promise<void> {
    await writeFile(pkgPath, JSON.stringify({ version: pkgVersion }));
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  }

  it("bumps the manifest version when it differs from package.json", async () => {
    await seed("9.9.9");

    const result = syncPluginVersion(pkgPath, manifestPath);
    expect(result).toEqual({ changed: true, version: "9.9.9" });

    const written = JSON.parse(await readFile(manifestPath, "utf-8"));
    expect(written.version).toBe("9.9.9");
  });

  it("is a no-op (file byte-identical) when versions match", async () => {
    await seed("1.0.0");
    const original = await readFile(manifestPath, "utf-8");

    const result = syncPluginVersion(pkgPath, manifestPath);
    expect(result).toEqual({ changed: false, version: "1.0.0" });
    // Byte equality is the load-bearing assertion — proves no rewrite.
    expect(await readFile(manifestPath, "utf-8")).toBe(original);
  });

  it("preserves all other manifest fields verbatim", async () => {
    await seed("2.0.0");
    syncPluginVersion(pkgPath, manifestPath);
    const written = JSON.parse(await readFile(manifestPath, "utf-8"));
    expect(written).toEqual({ ...baseManifest, version: "2.0.0" });
  });

  it("preserves the trailing newline and 2-space indent", async () => {
    await seed("3.0.0");
    syncPluginVersion(pkgPath, manifestPath);
    const raw = await readFile(manifestPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("\n  ");
    expect(raw).not.toContain("\n\t");
  });

  it("throws when package.json has no version field", async () => {
    await writeFile(pkgPath, JSON.stringify({}));
    await writeFile(manifestPath, JSON.stringify(baseManifest, null, 2) + "\n");
    expect(() => syncPluginVersion(pkgPath, manifestPath)).toThrow(/No version field/);
  });

  it("throws ENOENT when the manifest is missing", async () => {
    await writeFile(pkgPath, JSON.stringify({ version: "1.0.0" }));
    expect(() => syncPluginVersion(pkgPath, manifestPath)).toThrow(/ENOENT/);
  });

  it("throws on malformed JSON in the manifest", async () => {
    await writeFile(pkgPath, JSON.stringify({ version: "1.0.0" }));
    await writeFile(manifestPath, "{ not valid json");
    expect(() => syncPluginVersion(pkgPath, manifestPath)).toThrow(SyntaxError);
  });

  it("throws on malformed JSON in package.json", async () => {
    await writeFile(pkgPath, "{ not valid json");
    await writeFile(manifestPath, JSON.stringify(baseManifest, null, 2) + "\n");
    expect(() => syncPluginVersion(pkgPath, manifestPath)).toThrow(SyntaxError);
  });
});
