import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StdioServerConfig } from "../../src/config/schema.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fstatSync: (fd: number) => Object.assign(fs.fstatSync(fd), { size: 0 }) };
});

const { isSelfReference } = await import("../../src/config/self-reference.js");

describe("a package.json larger than its reported size", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "self-ref-size-"));
    const name = "@crabeye-ai/crabeye-mcp-bridge";
    const contents = {
      "my-clone": JSON.stringify({ name, pad: "x".repeat(10_000) }),
      huge: JSON.stringify({ name }) + " ".repeat(1024 * 1024),
    };
    for (const [dir, content] of Object.entries(contents)) {
      await mkdir(join(root, dir, "dist"), { recursive: true });
      await writeFile(join(root, dir, "package.json"), content);
      await writeFile(join(root, dir, "dist", "index.js"), "");
    }
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const server = (script: string) => ({ command: "node", args: [script] }) as StdioServerConfig;

  it("is still read in full", () => {
    expect(isSelfReference(server(join(root, "my-clone", "dist", "index.js")))).toBe(true);
  });

  it("is still refused past the size cap", () => {
    expect(isSelfReference(server(join(root, "huge", "dist", "index.js")))).toBe(false);
  });
});
