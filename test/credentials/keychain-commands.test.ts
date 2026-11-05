import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { randomBytes } from "node:crypto";

interface Outcome {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  stdinError?: boolean;
  noStdio?: boolean;
  hangs?: boolean;
}

interface Call {
  command: string;
  args: string[];
  stdin: string;
  options: unknown;
}

const tools = vi.hoisted(() => ({ calls: [] as Call[], outcomes: [] as Outcome[], home: "" }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => tools.home,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (command: string, args: string[], options: unknown) => {
    const call: Call = { command, args, stdin: "", options };
    tools.calls.push(call);
    const outcome = tools.outcomes.shift() ?? { code: 0 };
    if (outcome.noStdio) {
      const bare = Object.assign(new EventEmitter(), { stdin: null, stdout: null, stderr: null, kill: () => true });
      process.nextTick(() => {
        bare.emit("error", Object.assign(new Error(`spawn ${command} ${outcome.error}`), { code: outcome.error }));
        bare.emit("close", -24, null);
      });
      return bare;
    }
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new Writable({
        write(chunk: Buffer, _encoding, done) {
          call.stdin += chunk.toString();
          done();
        },
      }),
      kill: () => {
        setImmediate(() => child.emit("close", null, "SIGTERM"));
        return true;
      },
    });
    setImmediate(() => {
      if (outcome.stdinError) child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      if (outcome.error) child.emit("error", Object.assign(new Error(`spawn ${command} ${outcome.error}`), { code: outcome.error }));
      if (outcome.stdout) child.stdout.write(outcome.stdout);
      if (outcome.stderr) child.stderr.write(outcome.stderr);
      if (outcome.hangs) return;
      const exitCode = outcome.error ? -2 : outcome.code === undefined ? 0 : outcome.code;
      setImmediate(() => child.emit("close", exitCode, outcome.signal ?? null));
    });
    return child;
  },
}));

const { LinuxKeychain, MacKeychain, WindowsKeychain } = await import("../../src/credentials/keychain.js");
const { windowsPowerShellPath } = await import("../../src/process/process-utils.js");

const KEY = randomBytes(32);
const HEX = KEY.toString("hex");

function decodedScript(call: Call): string {
  return Buffer.from(call.args[call.args.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");
}

function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (err: Error) => err,
  );
}

describe("keychain commands", () => {
  beforeEach(() => {
    tools.home = mkdtempSync(join(tmpdir(), "cbe-keychain-"));
    tools.calls = [];
    tools.outcomes = [];
  });

  afterEach(() => {
    rmSync(tools.home, { recursive: true, force: true });
  });

  describe("on macOS", () => {
    it("gives security the key on stdin, never in its arguments, and checks it was stored", async () => {
      tools.outcomes = [{ code: 0 }, { code: 0, stdout: `${HEX}\n` }];

      await new MacKeychain().setKey(KEY);

      expect(tools.calls[0]).toEqual({
        command: "security",
        args: ["-i"],
        stdin: `add-generic-password -s crabeye-mcp-bridge -a master-key -w ${HEX} -U\n`,
        options: { windowsHide: true },
      });
      expect(tools.calls[1]!.args).toEqual(["find-generic-password", "-s", "crabeye-mcp-bridge", "-a", "master-key", "-w"]);
      expect(tools.calls.flatMap((call) => call.args).join(" ")).not.toContain(HEX);
    });

    it.each<[string, Outcome]>([
      ["finds no key", { code: 44, stderr: "security: The specified item could not be found in the keychain.\n" }],
      ["finds another key", { code: 0, stdout: randomBytes(32).toString("hex") }],
    ])("fails when security exits 0 but the read-back %s", async (_label, readBack) => {
      tools.outcomes = [{ code: 0 }, readBack];

      const err = await failure(new MacKeychain().setKey(KEY));

      expect(err.message).toBe("security failed: the master key was not stored in the keychain");
    });

    it.each<[string, Outcome, string]>([
      ["exits with no stderr", { code: 1 }, "security failed: exited with code 1"],
      ["is killed by a signal", { code: null, signal: "SIGKILL" }, "security failed: was killed by SIGKILL"],
      ["can't be started", { error: "ENOENT" }, "security failed: could not be started (ENOENT)"],
      ["can't be started for lack of file descriptors", { error: "EMFILE", noStdio: true }, "security failed: could not be started (EMFILE)"],
      ["closes stdin early and fails", { stdinError: true, code: 1 }, "security failed: exited with code 1"],
      ["exits with stderr", { code: 45, stderr: "add-generic-password: returned -25299\n" }, "security failed: exited with code 45: add-generic-password: returned -25299"],
    ])("reports security that %s without the key or its arguments", async (_label, outcome, message) => {
      tools.outcomes = [outcome];

      const err = await failure(new MacKeychain().setKey(KEY));

      expect(err.message).toBe(message);
      expect(err.message).not.toContain(HEX);
      expect(err.cause).toBeUndefined();
    });

    it("uses the given keychain file and service for every command", async () => {
      const keychain = new MacKeychain({ _keychain: "/scratch/k.keychain-db", _service: "svc" });
      tools.outcomes = [{ code: 0 }, { code: 0, stdout: HEX }, { code: 0 }];

      await keychain.setKey(KEY);
      await keychain.deleteKey();

      expect(tools.calls.map(({ args, stdin }) => ({ args, stdin }))).toEqual([
        { args: ["-i"], stdin: `add-generic-password -s svc -a master-key -w ${HEX} -U "/scratch/k.keychain-db"\n` },
        { args: ["find-generic-password", "-s", "svc", "-a", "master-key", "-w", "/scratch/k.keychain-db"], stdin: "" },
        { args: ["delete-generic-password", "-s", "svc", "-a", "master-key", "/scratch/k.keychain-db"], stdin: "" },
      ]);
    });

    it("stores the key when security closes stdin early but succeeds", async () => {
      tools.outcomes = [{ stdinError: true, code: 0 }, { code: 0, stdout: HEX }];

      await expect(new MacKeychain().setKey(KEY)).resolves.toBeUndefined();
    });

    it("finds no key when security can't find the item", async () => {
      tools.outcomes = [{ code: 44, stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n" }];

      await expect(new MacKeychain().getKey()).resolves.toBeUndefined();
    });

    it("fails to read the key when security can't be started", async () => {
      tools.outcomes = [{ error: "ENOENT" }];

      expect((await failure(new MacKeychain().getKey())).message).toBe("security failed: could not be started (ENOENT)");
    });
  });

  describe("time limit", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it.each<[string, Outcome, string]>([
      ["nothing on stderr", { hangs: true }, "security failed: timed out after 10s"],
      ["something on stderr", { hangs: true, stderr: "waiting\n" }, "security failed: timed out after 10s: waiting"],
    ])("stops security after 10s and reports it timed out, with %s", async (_label, outcome, message) => {
      tools.outcomes = [outcome];

      const failed = failure(new MacKeychain().setKey(KEY));
      await vi.advanceTimersByTimeAsync(10_000);

      expect((await failed).message).toBe(message);
    });

    it.each<[string, Outcome]>([
      ["can't be started", { error: "ENOENT" }],
      ["can't be started for lack of file descriptors", { error: "EMFILE", noStdio: true }],
      ["exits", { code: 1 }],
    ])("leaves no timer running once the tool %s", async (_label, outcome) => {
      tools.outcomes = [outcome];

      await failure(new MacKeychain().getKey());

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("on Linux", () => {
    it("gives secret-tool the key on stdin", async () => {
      await new LinuxKeychain().setKey(KEY);

      expect(tools.calls[0]!.stdin).toBe(HEX);
      expect(tools.calls[0]!.args.join(" ")).not.toContain(HEX);
    });

    it("finds no key when secret-tool exits 1 with no output", async () => {
      tools.outcomes = [{ code: 1 }];

      await expect(new LinuxKeychain().getKey()).resolves.toBeUndefined();
    });

    it.each<[string, Outcome, string]>([
      ["exits 2", { code: 2 }, "secret-tool failed: exited with code 2"],
      ["exits 1 with stderr", { code: 1, stderr: "no secret service\n" }, "secret-tool failed: exited with code 1: no secret service"],
      ["can't be started", { error: "ENOENT" }, "secret-tool failed: could not be started (ENOENT)"],
    ])("fails to read the key when secret-tool %s", async (_label, outcome, message) => {
      tools.outcomes = [outcome];

      expect((await failure(new LinuxKeychain().getKey())).message).toBe(message);
    });
  });

  describe("on Windows", () => {
    const loadsDpapiFirst = (script: string) => {
      const lines = script.split("\n");
      const firstUse = lines.findIndex((line) => line.includes("[Security.Cryptography.ProtectedData]"));
      return lines[0] === "Add-Type -AssemblyName System.Security" && firstUse > 0;
    };

    it("loads System.Security before reading the key with DPAPI, and writes the key straight to the console", async () => {
      tools.outcomes = [{ code: 0, stdout: HEX.toUpperCase() }];

      expect(await new WindowsKeychain().getKey()).toEqual(KEY);

      expect(tools.calls).toHaveLength(1);
      const script = decodedScript(tools.calls[0]!);
      expect(loadsDpapiFirst(script)).toBe(true);
      expect(script.split("\n").at(-1)).toBe("[Console]::Out.Write([BitConverter]::ToString($decrypted).Replace('-',''))");
    });

    it("finds no key when the DPAPI file doesn't exist", async () => {
      tools.outcomes = [{ code: 1, stderr: "Exception calling \"ReadAllBytes\": \"Could not find file 'C:\\Users\\me\\.crabeye-mcp-bridge\\master-key.dpapi'.\"\n" }];

      await expect(new WindowsKeychain().getKey()).resolves.toBeUndefined();
    });

    it("gives PowerShell the key on stdin, and writes it as before", async () => {
      await new WindowsKeychain().setKey(KEY);

      expect(tools.calls).toHaveLength(1);
      const call = tools.calls[0]!;
      const script = decodedScript(call);
      expect(call.command).toBe(windowsPowerShellPath());
      expect(call.stdin).toBe(`${HEX}\n`);
      expect(call.args.join(" ")).not.toContain(HEX);
      expect(script).not.toContain(HEX);
      expect(loadsDpapiFirst(script)).toBe(true);
      const readsStdin =
        "$hex = [Console]::In.ReadLine()\n" +
        "if ($hex -notmatch '^[0-9a-f]{64}$') { [Console]::Error.WriteLine('no master key on stdin'); exit 3 }\n";
      const writtenAs130 = script.replace(readsStdin, `$hex = '${HEX}'\n`);
      expect(writtenAs130).toBe(
        "Add-Type -AssemblyName System.Security\n" +
          `$hex = '${HEX}'\n` +
          "$bytes = [byte[]]::new($hex.Length / 2)\n" +
          "for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i*2, 2), 16) }\n" +
          "$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')\n" +
          `[IO.File]::WriteAllBytes('${join(tools.home, ".crabeye-mcp-bridge", "master-key.dpapi")}', $encrypted)`,
      );
    });

    it("fails when PowerShell can't be started, rather than finding no key", async () => {
      tools.outcomes = [{ error: "ENOENT" }];

      expect((await failure(new WindowsKeychain().getKey())).message).toBe("powershell failed: could not be started (ENOENT)");
    });
  });
});
