import { DaemonClient } from "./client.js";
import { netTransport } from "./net-transport.js";
import { getDaemonSocketPath } from "./paths.js";
import type { AuthChangedParams } from "./protocol.js";

const CONNECT_TIMEOUT_MS = 1_500;
const ANSWER_TIMEOUT_MS = 3_500;

export interface TellManagerOptions {
  socketPath?: string;
  connectTimeoutMs?: number;
  rpcTimeoutMs?: number;
  /** Stops waiting for the manager when aborted. */
  signal?: AbortSignal;
}

/**
 * Tells a running manager that the stored credentials of `upstream` changed,
 * so it connects that server again for every client at once. Never starts a
 * manager, and gives up quietly, within 5 seconds, when none answers or one
 * doesn't know the request.
 */
export async function tellManagerAuthChanged(upstream: string, opts: TellManagerOptions = {}): Promise<void> {
  if (opts.signal?.aborted) return;
  const params: AuthChangedParams = { upstream };
  let client: DaemonClient | undefined;
  const stop = () => client?.close();
  opts.signal?.addEventListener("abort", stop, { once: true });
  try {
    client = new DaemonClient({
      socketPath: opts.socketPath ?? getDaemonSocketPath(),
      transport: netTransport,
      connectTimeoutMs: opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
      rpcTimeoutMs: opts.rpcTimeoutMs ?? ANSWER_TIMEOUT_MS,
    });
    await client.connect();
    await client.call("AUTH_CHANGED", params);
  } catch {
    // ignore
  } finally {
    opts.signal?.removeEventListener("abort", stop);
    client?.close();
  }
}
