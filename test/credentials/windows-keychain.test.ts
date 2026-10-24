import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const scripts = vi.hoisted(() => ({ ran: [] as string[], home: "", stdout: "" }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => scripts.home,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: (_command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
    scripts.ran.push(Buffer.from(args[args.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le"));
    callback(null, scripts.stdout, "");
  },
}));

const { WindowsKeychain } = await import("../../src/credentials/keychain.js");

describe("WindowsKeychain PowerShell scripts", () => {
  beforeEach(() => {
    scripts.home = mkdtempSync(join(tmpdir(), "cbe-dpapi-"));
    scripts.ran = [];
  });

  afterEach(() => {
    rmSync(scripts.home, { recursive: true, force: true });
  });

  const loadsDpapiFirst = (script: string) => {
    const lines = script.split("\n");
    const firstUse = lines.findIndex((line) => line.includes("[Security.Cryptography.ProtectedData]"));
    return lines[0] === "Add-Type -AssemblyName System.Security" && firstUse > 0;
  };

  it("loads System.Security before reading the key with DPAPI", async () => {
    const key = randomBytes(32);
    scripts.stdout = key.toString("hex").toUpperCase();

    expect(await new WindowsKeychain().getKey()).toEqual(key);

    expect(scripts.ran).toHaveLength(1);
    expect(loadsDpapiFirst(scripts.ran[0]!)).toBe(true);
  });

  it("loads System.Security before writing the key with DPAPI", async () => {
    scripts.stdout = "";

    await new WindowsKeychain().setKey(randomBytes(32));

    expect(scripts.ran).toHaveLength(1);
    expect(loadsDpapiFirst(scripts.ran[0]!)).toBe(true);
  });
});
