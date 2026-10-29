import { auth } from "@modelcontextprotocol/client";
import { CredentialStore } from "../../../src/credentials/credential-store.js";
import { EnvKeychain } from "../../../src/credentials/keychain.js";
import { runtimeProvider } from "../refresh-race.js";

const [storePath, resourceUrl, lockTimeoutMs] = process.argv.slice(2);
const store = new CredentialStore({
  keychain: new EnvKeychain(process.env.MCP_BRIDGE_MASTER_KEY ?? ""),
  filePath: storePath!,
  lockTimeoutMs: Number(lockTimeoutMs),
});
const provider = runtimeProvider(store);

try {
  const result = await auth(provider, { serverUrl: resourceUrl!, fetchFn: provider.wrapFetch(fetch) });
  process.stdout.write(`${JSON.stringify({ result })}\n`);
} catch (err) {
  process.stdout.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
}
