import { afterEach, describe, expect, it, vi } from "vitest";
import { authCommand, reauthorizationError } from "../../src/upstream/call-errors.js";

describe("authCommand", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const on = (platform: NodeJS.Platform) => vi.stubGlobal("process", { ...process, platform });

  it("names a plain server as it is", () => {
    expect(authCommand("linear")).toBe("crabeye-mcp-bridge auth linear");
    expect(authCommand("my-server.v2", { remove: true })).toBe("crabeye-mcp-bridge auth --remove my-server.v2");
  });

  it("single-quotes a server name the shell would split, expand or run, on macOS and Linux", () => {
    on("linux");

    expect(authCommand("my server")).toBe("crabeye-mcp-bridge auth 'my server'");
    expect(authCommand("x; rm -rf ~")).toBe("crabeye-mcp-bridge auth 'x; rm -rf ~'");
    expect(authCommand("it's")).toBe("crabeye-mcp-bridge auth 'it'\\''s'");
    expect(authCommand("=ls")).toBe("crabeye-mcp-bridge auth '=ls'");
  });

  it("single-quotes a server name the way PowerShell reads it on Windows, so $, backticks and curly quotes stay as they are", () => {
    on("win32");

    expect(authCommand("a$b `c' d")).toBe("crabeye-mcp-bridge auth 'a$b `c'' d'");
    expect(authCommand("@splat")).toBe("crabeye-mcp-bridge auth '@splat'");
    expect(authCommand("x\u2019;calc;\u2019x")).toBe("crabeye-mcp-bridge auth 'x\u2019\u2019;calc;\u2019\u2019x'");
    expect(authCommand("\u2018a\u201ab\u201b")).toBe("crabeye-mcp-bridge auth '\u2018\u2018a\u201a\u201ab\u201b\u201b'");
    expect(authCommand("a,b")).toBe("crabeye-mcp-bridge auth 'a,b'");
  });

  it("keeps a server name that starts with - from being read as an option", () => {
    on("linux");

    expect(authCommand("--remove=github")).toBe("crabeye-mcp-bridge auth -- '--remove=github'");
    expect(authCommand("-x", { remove: true })).toBe("crabeye-mcp-bridge auth --remove='-x'");
  });

  it("is what the re-authorization error tells the user to run", () => {
    on("linux");

    expect(reauthorizationError("my server", "my server").message).toBe(
      "Upstream server \"my server\" needs re-authorization. Run: crabeye-mcp-bridge auth 'my server' (or update its configured credentials if it does not use OAuth).",
    );
  });
});
