import { createInterface } from "node:readline";
import { CredentialStore } from "../../../src/credentials/credential-store.js";
import { EnvKeychain, WindowsKeychain, type KeychainAdapter } from "../../../src/credentials/keychain.js";
import { FileKeychain } from "../file-keychain.js";

const [storePath, op, prefix, count, keySource, keyFile, readDelayMs] = process.argv.slice(2);

function keychainFor(source: string | undefined): KeychainAdapter {
  switch (source) {
    case "env":
      return new EnvKeychain(process.env.MCP_BRIDGE_MASTER_KEY ?? "");
    case "file":
      return new FileKeychain(keyFile!, Number(readDelayMs ?? 0));
    case "dpapi":
      return new WindowsKeychain();
    default:
      throw new Error(`unknown key source ${source}`);
  }
}

const store = new CredentialStore({ keychain: keychainFor(keySource), filePath: storePath! });

async function apply(i: number): Promise<void> {
  const key = `${prefix}-${i}`;
  switch (op) {
    case "set":
      await store.set(key, { type: "secret", value: key });
      return;
    case "delete":
      await store.delete(key);
      return;
    case "deleteMany":
      await store.deleteMany([key]);
      return;
    case "list":
      process.stdout.write(`keys: ${(await store.list()).sort().join(",")}\n`);
      return;
    default:
      throw new Error(`unknown op ${op}`);
  }
}

process.stdout.write("ready\n");
const input = createInterface({ input: process.stdin });
input.once("line", async () => {
  try {
    for (let i = 0; i < Number(count); i++) await apply(i);
    process.stdout.write("done\n");
  } catch (err) {
    process.stdout.write(`error: ${JSON.stringify(err instanceof Error ? err.message : String(err))}\n`);
  }
  input.close();
});
