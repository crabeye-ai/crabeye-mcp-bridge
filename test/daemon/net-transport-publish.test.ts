import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const competitor: { server: Server | null; path: string | null } = { server: null, path: null };

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (from: string, to: string) => {
      if (to === competitor.path && competitor.server === null) {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(to, resolve));
        competitor.server = server;
      }
      return actual.link(from, to);
    },
  };
});

const { isServing, netTransport } = await import("../../src/daemon/net-transport.js");
const { SocketInUseError } = await import("../../src/daemon/transport.js");

describe.skipIf(process.platform === "win32")("daemon socket publish", () => {
  const dir = mkdtempSync("/tmp/cbe-pub-");

  afterEach(() => {
    competitor.server?.close();
    competitor.server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to replace a socket that appeared after the liveness probe", async () => {
    competitor.path = join(dir, "m.sock");
    const server = netTransport.createServer({ path: competitor.path, onConnection: () => {} });

    await expect(server.start()).rejects.toBeInstanceOf(SocketInUseError);

    expect(await isServing(competitor.path)).toBe(true);
    expect(readdirSync(dir).filter((name) => name.startsWith(".s"))).toEqual([]);
  });
});
