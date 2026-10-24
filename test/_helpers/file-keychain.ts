import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { KeychainAdapter } from "../../src/credentials/keychain.js";

export class FileKeychain implements KeychainAdapter {
  constructor(
    private readonly keyPath: string,
    private readonly readDelayMs = 0,
  ) {}

  async getKey(): Promise<Buffer | undefined> {
    if (this.readDelayMs > 0) await sleep(this.readDelayMs);
    try {
      return Buffer.from(await readFile(this.keyPath, "utf-8"), "hex");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async setKey(key: Buffer): Promise<void> {
    await appendFile(keyWritesPath(this.keyPath), `${process.pid}\n`);
    await writeFile(this.keyPath, key.toString("hex"));
  }

  async deleteKey(): Promise<void> {
    await rm(this.keyPath, { force: true });
  }
}

function keyWritesPath(keyPath: string): string {
  return `${keyPath}.writes`;
}

export async function keyWrites(keyPath: string): Promise<number> {
  const log = await readFile(keyWritesPath(keyPath), "utf-8").catch(() => "");
  return log.split("\n").filter(Boolean).length;
}
