import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const linkCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async () => {
      linkCalls.count++;
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    },
  };
});

const { writeThroughAliasedPaths } = await import("../_helpers/credential-store.js");

describe("credential store lock on a filesystem without hard links", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cbe-store-nolink-"));
    linkCalls.count = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("still serializes writers that share the file but not an in-process queue", async () => {
    const direct = await writeThroughAliasedPaths(dir, 30);

    expect(linkCalls.count).toBeGreaterThan(0);
    expect(await direct.list()).toHaveLength(60);
  });
});
