import tls from "node:tls";
import { networkSettings } from "../../../src/daemon/instance-env.js";
import { networkFetch } from "../../../src/daemon/instances/network.js";
import { createNoopLogger } from "../../../src/logging/index.js";

const stores: string[] = [];
const connect = tls.connect;
tls.connect = ((...args: Parameters<typeof tls.connect>) => {
  const options = args[0] as tls.ConnectionOptions | undefined;
  stores.push(options?.secureContext ? "own list" : "default store");
  return connect(...args);
}) as typeof tls.connect;

const [url, clientEnv] = process.argv.slice(2);
const created = networkFetch(networkSettings(JSON.parse(clientEnv!) as Record<string, string>), createNoopLogger());
created
  .fetch(url!)
  .then(async (response) => process.stdout.write(`ok ${await response.text()} (${stores.join(", ")})\n`))
  .catch((err: unknown) => process.stdout.write(`failed ${err instanceof Error ? err.message : String(err)} (${stores.join(", ")})\n`))
  .finally(() => created.close());
