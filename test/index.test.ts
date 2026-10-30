import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("crabeye-mcp-bridge", () => {
  const argv = process.argv;
  let dir: string | undefined;

  afterEach(async () => {
    process.argv = argv;
    vi.restoreAllMocks();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("can import the CLI module without starting a bridge", async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-index-"));
    const config = join(dir, "empty.json");
    await writeFile(config, JSON.stringify({ mcpServers: {} }));
    process.argv = [process.execPath, "crabeye-mcp-bridge", "--validate", "--config", config];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const mod = await import("../src/index.js");

    expect(mod).toBeDefined();
    await vi.waitFor(() => expect(stderr).toHaveBeenCalledWith("Config OK — 0 upstream servers\n"));
  });
});
