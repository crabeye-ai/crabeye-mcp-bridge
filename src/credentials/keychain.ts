import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { APP_NAME, CREDENTIALS_DIR } from "../constants.js";
import { CredentialError } from "./errors.js";

const SERVICE = APP_NAME;
const ACCOUNT = "master-key";
const EXEC_TIMEOUT = 10_000;
const LOAD_DPAPI = "Add-Type -AssemblyName System.Security\n";

export interface KeychainAdapter {
  /** Returns the key, or undefined if no key has been stored yet. */
  getKey(): Promise<Buffer | undefined>;
  setKey(key: Buffer): Promise<void>;
  deleteKey(): Promise<void>;
}

// --- Helpers ---

function runTool(label: string, command: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, EXEC_TIMEOUT);
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const fail = (reason: string): void => {
      const detail = stderr.trim();
      settle(() => reject(new CredentialError(`${label} failed: ${detail ? `${reason}: ${detail}` : reason}`)));
    };

    child.on("error", (error: NodeJS.ErrnoException) => fail(`could not be started (${error.code ?? "unknown error"})`));
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("close", (code, signal) => {
      if (code === 0) settle(() => resolve(stdout.trim()));
      else if (timedOut) fail(`timed out after ${EXEC_TIMEOUT / 1000}s`);
      else if (signal !== null) fail(`was killed by ${signal}`);
      else fail(`exited with code ${code}`);
    });

    // Suppress EPIPE if child exits before we finish writing.
    // The actual exit code/error is handled by the 'close'/'error' listeners.
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}

function parseHexKey(hex: string, source: string): Buffer {
  const cleaned = hex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    throw new CredentialError(
      `Invalid master key from ${source}: expected exactly 64 hex characters (32 bytes), got ${cleaned.length}`,
    );
  }
  return Buffer.from(cleaned, "hex");
}

// --- EnvKeychain ---

export class EnvKeychain implements KeychainAdapter {
  private readonly key: Buffer;

  constructor(hex: string) {
    this.key = parseHexKey(hex, "MCP_BRIDGE_MASTER_KEY");
  }

  async getKey(): Promise<Buffer> {
    return this.key;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async setKey(key: Buffer): Promise<void> {
    throw new CredentialError(
      "Cannot set master key when using MCP_BRIDGE_MASTER_KEY environment variable",
    );
  }

  async deleteKey(): Promise<void> {
    throw new CredentialError(
      "Cannot delete master key when using MCP_BRIDGE_MASTER_KEY environment variable",
    );
  }
}

// --- MacKeychain ---

export interface MacKeychainOptions {
  /** Test override for the keychain file, instead of the default keychain. */
  _keychain?: string;
  /** Test override for the service name the key is stored under. */
  _service?: string;
}

export class MacKeychain implements KeychainAdapter {
  private readonly service: string;
  private readonly keychainArgs: string[];

  constructor(options: MacKeychainOptions = {}) {
    this.service = options._service ?? SERVICE;
    this.keychainArgs = options._keychain === undefined ? [] : [options._keychain];
  }

  private security(args: string[], stdin?: string): Promise<string> {
    return runTool("security", "security", args, stdin);
  }

  async getKey(): Promise<Buffer | undefined> {
    try {
      const hex = await this.security([
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        ACCOUNT,
        "-w",
        ...this.keychainArgs,
      ]);
      return parseHexKey(hex, "macOS keychain");
    } catch (err) {
      // security exits 44 with "could not be found" when item doesn't exist
      if (err instanceof CredentialError && /could not be found/i.test(err.message)) {
        return undefined;
      }
      throw err;
    }
  }

  async setKey(key: Buffer): Promise<void> {
    const keychainSuffix = this.keychainArgs.map((path) => ` "${path}"`).join("");
    await this.security(["-i"], `add-generic-password -s ${this.service} -a ${ACCOUNT} -w ${key.toString("hex")} -U${keychainSuffix}\n`);
    if (!(await this.getKey())?.equals(key)) {
      throw new CredentialError("security failed: the master key was not stored in the keychain");
    }
  }

  async deleteKey(): Promise<void> {
    await this.security([
      "delete-generic-password",
      "-s",
      this.service,
      "-a",
      ACCOUNT,
      ...this.keychainArgs,
    ]);
  }
}

// --- LinuxKeychain ---

export class LinuxKeychain implements KeychainAdapter {
  private secretTool(args: string[], stdin?: string): Promise<string> {
    return runTool("secret-tool", "secret-tool", args, stdin);
  }

  async getKey(): Promise<Buffer | undefined> {
    try {
      const hex = await this.secretTool([
        "lookup",
        "service",
        SERVICE,
        "account",
        ACCOUNT,
      ]);
      if (!hex) return undefined;
      return parseHexKey(hex, "secret-tool");
    } catch (err) {
      // secret-tool exits 1 with empty stderr when key doesn't exist.
      if (err instanceof CredentialError && err.message === "secret-tool failed: exited with code 1") {
        return undefined;
      }
      throw err;
    }
  }

  async setKey(key: Buffer): Promise<void> {
    await this.secretTool(
      [
        "store",
        "--label",
        `${APP_NAME} master key`,
        "service",
        SERVICE,
        "account",
        ACCOUNT,
      ],
      key.toString("hex"),
    );
  }

  async deleteKey(): Promise<void> {
    await this.secretTool([
      "clear",
      "service",
      SERVICE,
      "account",
      ACCOUNT,
    ]);
  }
}

// --- WindowsKeychain ---

export class WindowsKeychain implements KeychainAdapter {
  private get filePath(): string {
    return join(homedir(), CREDENTIALS_DIR, "master-key.dpapi");
  }

  private escapeSingleQuote(s: string): string {
    return s.replace(/'/g, "''");
  }

  private encodedCommand(script: string): string[] {
    // -EncodedCommand accepts a Base64-encoded UTF-16LE string, avoiding
    // any injection via interpolated paths.
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
  }

  private powershell(script: string, stdin?: string): Promise<string> {
    return runTool("powershell", "powershell", this.encodedCommand(script), stdin);
  }

  async getKey(): Promise<Buffer | undefined> {
    try {
      const script =
        LOAD_DPAPI +
        `$bytes = [IO.File]::ReadAllBytes('${this.escapeSingleQuote(this.filePath)}')\n` +
        `$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')\n` +
        `[Console]::Out.Write([BitConverter]::ToString($decrypted).Replace('-',''))`;
      const hex = await this.powershell(script);
      return parseHexKey(hex, "DPAPI");
    } catch (err) {
      // FileNotFoundException when the DPAPI file doesn't exist yet
      if (err instanceof CredentialError && /Could not find|does not exist|FileNotFound/i.test(err.message)) {
        return undefined;
      }
      throw err;
    }
  }

  async setKey(key: Buffer): Promise<void> {
    const dir = join(homedir(), CREDENTIALS_DIR);
    await mkdir(dir, { recursive: true });
    const escapedPath = this.escapeSingleQuote(this.filePath);
    const script =
      LOAD_DPAPI +
      `$hex = [Console]::In.ReadLine()\n` +
      `if ($hex -notmatch '^[0-9a-f]{64}$') { [Console]::Error.WriteLine('no master key on stdin'); exit 3 }\n` +
      `$bytes = [byte[]]::new($hex.Length / 2)\n` +
      `for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i*2, 2), 16) }\n` +
      `$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')\n` +
      `[IO.File]::WriteAllBytes('${escapedPath}', $encrypted)`;
    await this.powershell(script, `${key.toString("hex")}\n`);
  }

  async deleteKey(): Promise<void> {
    await this.powershell(`Remove-Item -LiteralPath '${this.escapeSingleQuote(this.filePath)}' -Force -ErrorAction Stop`);
  }
}

// --- Factory ---

export const MASTER_KEY_ENV = "MCP_BRIDGE_MASTER_KEY";

export interface CreateKeychainOptions {
  /** Where to look for `MCP_BRIDGE_MASTER_KEY`. Defaults to this process's environment. */
  env?: Record<string, string | undefined>;
  _adapter?: KeychainAdapter;
  _platform?: NodeJS.Platform;
}

export function createKeychainAdapter(
  options?: CreateKeychainOptions,
): KeychainAdapter {
  if (options?._adapter) {
    return options._adapter;
  }

  const envKey = (options?.env ?? process.env)[MASTER_KEY_ENV];
  if (envKey) {
    return new EnvKeychain(envKey);
  }

  const os = options?._platform ?? platform();
  switch (os) {
    case "darwin":
      return new MacKeychain();
    case "linux":
      return new LinuxKeychain();
    case "win32":
      return new WindowsKeychain();
    default:
      throw new CredentialError(`Unsupported platform for keychain: ${os}`);
  }
}
