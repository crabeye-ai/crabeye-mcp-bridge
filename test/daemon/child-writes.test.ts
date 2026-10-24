import { describe, it, expect } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const daemonDir = fileURLToPath(new URL("../../src/daemon/", import.meta.url));

describe("writes to STDIO children", () => {
  it("go through the single helper that tells the child's era what was written", async () => {
    const files = (await readdir(daemonDir)).filter((name) => name.endsWith(".ts"));
    const sources = await Promise.all(files.map(async (name) => [name, await readFile(join(daemonDir, name), "utf-8")] as const));

    const writes = sources.flatMap(([name, source]) => (source.match(/\bchild\.send\(/g) ?? []).map(() => name));

    expect(writes).toEqual(["manager.ts"]);
    expect(sources.find(([name]) => name === "manager.ts")![1]).toMatch(/group\.child\.send\(payload\);\s+group\.era\.noteWritten\(payload\);/);
  });
});
