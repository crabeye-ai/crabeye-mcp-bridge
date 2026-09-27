import { describe, it, expect } from "vitest";
import { DaemonStdioClient } from "../../src/upstream/daemon-stdio-client.js";

describe("DaemonStdioTransport stdio shape", () => {
  it("declares the structural markers the SDK's probe classifier looks for", () => {
    const client = new DaemonStdioClient({
      name: "mock",
      config: { command: "node", args: ["server.js"] },
      resolvedEnv: {},
    });
    const transport = (
      client as unknown as { _buildTransport(): object }
    )._buildTransport();

    expect("stderr" in transport).toBe(true);
    expect("pid" in transport).toBe(true);
  });
});
