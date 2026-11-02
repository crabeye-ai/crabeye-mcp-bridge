import type { UpstreamClient } from "../upstream/types.js";
import type { Logger } from "../logging/index.js";
import { cancelledError, reauthorizationError, removedError, unavailableError } from "../upstream/call-errors.js";

export const WAIT_FOR_RESPAWN_MS = 30_000;

/** The part of a client that waiting for it to connect needs. */
export type WaitableClient = Pick<UpstreamClient, "name" | "status" | "retryNow" | "onStatusChange">;

export interface UpstreamWaitOptions<C extends WaitableClient = UpstreamClient> {
  getClient: (name: string) => C | undefined;
  onClientsChanged?: (listener: () => void) => () => void;
  signal?: AbortSignal;
  logger?: Logger;
}

type WaitOutcome = "changed" | "timeout" | "cancelled";

/** Settles when `work` does, or once `WAIT_FOR_RESPAWN_MS` has passed. */
export async function atMostRespawnWait(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, WAIT_FOR_RESPAWN_MS)));
  try {
    await Promise.race([work, timeUp]);
  } finally {
    clearTimeout(timer);
  }
}

export async function untilSettledOrCancelled(work: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw cancelledError();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function awaitConnectedClient<C extends WaitableClient>(source: string, options: UpstreamWaitOptions<C>): Promise<C> {
  const deadline = Date.now() + WAIT_FOR_RESPAWN_MS;
  let waiting = false;
  let retried: C | undefined;
  for (;;) {
    if (options.signal?.aborted) throw cancelledError();
    const client = options.getClient(source);
    if (!client) throw removedError(source);
    if (client.status === "connected") {
      if (waiting) options.logger?.info("server reconnected, executing tool call", { server: source });
      return client;
    }
    if (client !== retried) {
      void client.retryNow();
      retried = client;
    }
    if (client.status === "auth_required") throw reauthorizationError(source, client.name);
    if (!waiting) {
      options.logger?.info("waiting for server to reconnect", { server: source });
      waiting = true;
    }
    const outcome = await nextChange(client, deadline - Date.now(), options);
    if (outcome === "cancelled") throw cancelledError();
    if (outcome === "timeout") throw unavailableError(source);
  }
}

function nextChange<C extends WaitableClient>(client: C, timeoutMs: number, options: UpstreamWaitOptions<C>): Promise<WaitOutcome> {
  const { onClientsChanged, signal } = options;
  return new Promise<WaitOutcome>((resolve) => {
    const cleanups: Array<() => void> = [];
    let settled = false;
    const settle = (outcome: WaitOutcome): void => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      resolve(outcome);
    };

    const timer = setTimeout(() => settle("timeout"), Math.max(0, timeoutMs));
    cleanups.push(() => clearTimeout(timer));
    cleanups.push(client.onStatusChange((event) => {
      if (event.current === "connected" || event.current === "auth_required") settle("changed");
    }));
    if (onClientsChanged) cleanups.push(onClientsChanged(() => settle("changed")));
    if (signal) {
      const onAbort = (): void => settle("cancelled");
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    }
    if (client.status === "connected" || client.status === "auth_required") settle("changed");
  });
}
