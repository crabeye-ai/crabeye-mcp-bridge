import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { APP_NAME, CREDENTIALS_DIR } from "../constants.js";
import { CredentialError } from "./errors.js";

const SERVICE = APP_NAME;
const ACCOUNT = "master-key";
const EXEC_TIMEOUT = 10_000;

export interface KeychainAdapter {
  /** Returns the key, or undefined if no key has been stored yet. */
  getKey(): Promise<Buffer | undefined>;
  setKey(key: Buffer): Promise<void>;
  deleteKey(): Promise<void>;
}

// --- Helpers ---

function execCommand(
  command: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: EXEC_TIMEOUT },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new CredentialError(
              `${command} failed: ${stderr?.trim() || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

function spawnWithStdin(
  command: string,
  args: string[],
  stdin: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { timeout: EXEC_TIMEOUT });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(
        new CredentialError(`${command} failed: ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(
          new CredentialError(
            `${command} exited with code ${code}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolve(stdout.trim());
    });

    // Suppress EPIPE if child exits before we finish writing.
    // The actual exit code/error is handled by the 'close'/'error' listeners.
    child.stdin.on("error", () => {});
    child.stdin.write(stdin);
    child.stdin.end();
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

export class MacKeychain implements KeychainAdapter {
  async getKey(): Promise<Buffer | undefined> {
    try {
      const hex = await execCommand("security", [
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        ACCOUNT,
        "-w",
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
    const hex = key.toString("hex");
    await execCommand("security", [
      "add-generic-password",
      "-s",
      SERVICE,
      "-a",
      ACCOUNT,
      "-w",
      hex,
      "-U",
    ]);
  }

  async deleteKey(): Promise<void> {
    await execCommand("security", [
      "delete-generic-password",
      "-s",
      SERVICE,
      "-a",
      ACCOUNT,
    ]);
  }
}

// --- LinuxKeychain ---

export class LinuxKeychain implements KeychainAdapter {
  async getKey(): Promise<Buffer | undefined> {
    try {
      const hex = await execCommand("secret-tool", [
        "lookup",
        "service",
        SERVICE,
        "account",
        ACCOUNT,
      ]);
      // secret-tool returns empty stdout when key not found (before exiting 1)
      if (!hex) return undefined;
      return parseHexKey(hex, "secret-tool");
    } catch (err) {
      // secret-tool exits 1 with empty stderr when key doesn't exist.
      // execCommand formats this as "secret-tool failed: Command failed: ..."
      if (err instanceof CredentialError && /secret-tool failed:.*Command failed/i.test(err.message)) {
        return undefined;
      }
      throw err;
    }
  }

  async setKey(key: Buffer): Promise<void> {
    const hex = key.toString("hex");
    await spawnWithStdin(
      "secret-tool",
      [
        "store",
        "--label",
        `${APP_NAME} master key`,
        "service",
        SERVICE,
        "account",
        ACCOUNT,
      ],
      hex,
    );
  }

  async deleteKey(): Promise<void> {
    await execCommand("secret-tool", [
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
    // any injection via interpolated paths or values.
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    return ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
  }

  async getKey(): Promise<Buffer | undefined> {
    try {
      const script =
        `$bytes = [IO.File]::ReadAllBytes('${this.escapeSingleQuote(this.filePath)}')\n` +
        `$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')\n` +
        `[BitConverter]::ToString($decrypted).Replace('-','')`;
      const hex = await execCommand("powershell", this.encodedCommand(script));
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
    const hex = key.toString("hex");
    const escapedPath = this.escapeSingleQuote(this.filePath);
    const script =
      `$hex = '${hex}'\n` +
      `$bytes = [byte[]]::new($hex.Length / 2)\n` +
      `for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i*2, 2), 16) }\n` +
      `$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')\n` +
      `[IO.File]::WriteAllBytes('${escapedPath}', $encrypted)`;
    await execCommand("powershell", this.encodedCommand(script));
  }

  async deleteKey(): Promise<void> {
    const script = `Remove-Item -LiteralPath '${this.escapeSingleQuote(this.filePath)}' -Force -ErrorAction Stop`;
    await execCommand("powershell", this.encodedCommand(script));
  }
}

// --- Factory ---

export interface CreateKeychainOptions {
  _adapter?: KeychainAdapter;
  _platform?: NodeJS.Platform;
}

export function createKeychainAdapter(
  options?: CreateKeychainOptions,
): KeychainAdapter {
  if (options?._adapter) {
    return options._adapter;
  }

  const envKey = process.env.MCP_BRIDGE_MASTER_KEY;
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
