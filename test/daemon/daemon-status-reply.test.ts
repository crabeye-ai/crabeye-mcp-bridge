import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonStatus } from "../../src/daemon/bootstrap.js";
import { closeServer, serveFrames } from "../_helpers/frame-server.js";

describe.skipIf(process.platform === "win32")("daemonStatus", () => {
  let dir: string;
  let server: Server | undefined;

  beforeEach(async () => {
    dir = await mkdtemp("/tmp/cbe-daemon-status-");
  });

  afterEach(async () => {
    if (server) await closeServer(server);
    server = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it.each([null, "1.3.0", 7])("treats a STATUS answer of %j as no daemon", async (result) => {
    const socketPath = join(dir, "odd.sock");
    server = await serveFrames(socketPath, () => result);

    expect(await daemonStatus(socketPath)).toBeNull();
  });
});
