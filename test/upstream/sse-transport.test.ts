import { describe, it, expect, vi } from "vitest";
import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { HttpUpstreamClient } from "../../src/upstream/http-client.js";
import type { Logger } from "../../src/logging/index.js";

function spyLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
  };
  return logger;
}

describe("HttpUpstreamClient transport selection", () => {
  function buildTransport(type: "sse" | "streamable-http", logger = spyLogger()) {
    const client = new HttpUpstreamClient({
      name: "mock",
      logger,
      config: { type, url: "http://localhost:9999/mcp" },
    });
    return (client as unknown as { _buildTransport(): unknown })._buildTransport();
  }

  it("uses the deprecated SSE transport for type: sse", () => {
    const logger = spyLogger();
    expect(buildTransport("sse", logger)).toBeInstanceOf(SSEClientTransport);
    expect(logger.warn.mock.calls[0][0]).toMatch(/deprecated.*2027-07-28/);
  });

  it("warns once per client, not on every reconnect", () => {
    const logger = spyLogger();
    const client = new HttpUpstreamClient({
      name: "mock",
      logger,
      config: { type: "sse", url: "http://localhost:9999/mcp" },
    });
    const build = () =>
      (client as unknown as { _buildTransport(): unknown })._buildTransport();

    build();
    build();
    build();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("uses Streamable HTTP otherwise, without a deprecation warning", () => {
    const logger = spyLogger();
    expect(buildTransport("streamable-http", logger)).toBeInstanceOf(StreamableHTTPClientTransport);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
