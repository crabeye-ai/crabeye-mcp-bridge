import { describe, expect, it } from "vitest";
import { UPSTREAM_MARKER_ENV } from "../../../src/constants.js";
import { spawnEnv } from "../../../src/daemon/instances/child-env.js";

const marker = { [UPSTREAM_MARKER_ENV]: String(process.pid) };

describe("spawnEnv", () => {
  it("puts the server's env over the client's, and marks the child as started by this manager", () => {
    expect(spawnEnv({ PATH: "/bin", MODE: "client" }, { MODE: "server", TOKEN: "t" }, "linux")).toEqual({ PATH: "/bin", MODE: "server", TOKEN: "t", ...marker });
  });

  it("drops variables that make the server's runtime load other code, from either source", () => {
    const spawned = spawnEnv({ LD_PRELOAD: "/evil.so", NODE_OPTIONS: "--require x" }, { PYTHONPATH: "/x", DYLD_INSERT_LIBRARIES: "/y" }, "darwin");

    expect(spawned).toEqual(marker);
  });

  it("never passes the master key, even when the server's env sets it", () => {
    expect(spawnEnv({ MCP_BRIDGE_MASTER_KEY: "k" }, { MCP_BRIDGE_MASTER_KEY: "k2" }, "linux")).toEqual(marker);
  });

  it("overrides a marker the client or the server sets", () => {
    expect(spawnEnv({ [UPSTREAM_MARKER_ENV]: "1" }, { [UPSTREAM_MARKER_ENV]: "2" }, "linux")).toEqual(marker);
  });

  it("treats names differing only in case as one variable on Windows, keeping the server's spelling", () => {
    expect(spawnEnv({ Path: "C:\\client" }, { PATH: "C:\\server" }, "win32")).toEqual({ PATH: "C:\\server", ...marker });
    expect(spawnEnv({ node_options: "--require x", Mcp_Bridge_Master_Key: "k" }, {}, "win32")).toEqual(marker);
  });

  it("keeps names differing only in case apart elsewhere", () => {
    expect(spawnEnv({ Path: "/client" }, { PATH: "/server" }, "linux")).toEqual({ Path: "/client", PATH: "/server", ...marker });
  });
});
