import { tellManagerAuthChanged } from "../../../src/daemon/auth-changed.js";

const [socketPath] = process.argv.slice(2);
await tellManagerAuthChanged("svc", { socketPath: socketPath!, rpcTimeoutMs: 300 });
process.stdout.write("returned\n");
