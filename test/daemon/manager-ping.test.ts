import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnTestManager, type DaemonFixture } from "../_helpers/daemon-fixtures.js";
import type { PingParams, PingResult } from "../../src/daemon/protocol.js";

const isWindows = process.platform === "win32";

describe.skipIf(isWindows)("ManagerDaemon — PING handler", () => {
  let fx: DaemonFixture;

  beforeEach(async () => {
    fx = await spawnTestManager();
  });
  afterEach(async () => {
    await fx.stop();
  });

  it("echoes the seq", async () => {
    const params: PingParams = { seq: 42 };
    const res = (await fx.client.call("PING", params)) as PingResult;
    expect(res).toEqual({ seq: 42 });
  });

  it("rejects non-number seq with invalid_params", async () => {
    await expect(fx.client.call("PING", { seq: "x" })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  it("rejects non-integer / negative seq with invalid_params", async () => {
    await expect(fx.client.call("PING", { seq: 3.14 })).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(fx.client.call("PING", { seq: -1 })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });
});
