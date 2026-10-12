import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import type { UpstreamClient } from "../upstream/types.js";
import type { Logger } from "../logging/index.js";
import { APP_NAME } from "../constants.js";

export const WAIT_FOR_RESPAWN_MS = 30_000;

export interface UpstreamWaitOptions {
  getClient: (name: string) => UpstreamClient | undefined;
  onClientsChanged?: (listener: () => void) => () => void;
  signal?: AbortSignal;
  logger?: Logger;
}

type WaitOutcome = "changed" | "timeout" | "cancelled";

export function reauthorizationError(source: string, serverName: string): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    `Upstream server "${source}" needs re-authorization. Run: ${APP_NAME} auth ${serverName} ` +
      "(or update its configured credentials if it does not use OAuth).",
  );
}

export function cancelledError(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InternalError, "Request cancelled");
}

export function removedError(source: string): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    `Upstream server "${source}" was removed from the configuration`,
  );
}

function unavailableError(source: string): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    `Upstream server "${source}" is unavailable; reconnecting in the background. Please retry shortly.`,
  );
}

export async function awaitConnectedClient(source: string, options: UpstreamWaitOptions): Promise<UpstreamClient> {
  const deadline = Date.now() + WAIT_FOR_RESPAWN_MS;
  let waiting = false;
  let retried: UpstreamClient | undefined;
  for (;;) {
    if (options.signal?.aborted) throw cancelledError();
    const client = options.getClient(source);
    if (!client) throw removedError(source);
    if (client.status === "connected") {
      if (waiting) options.logger?.info("server reconnected, executing tool call", { component: "bridge", server: source });
      return client;
    }
    if (client !== retried) {
      void client.retryNow();
      retried = client;
    }
    if (client.status === "auth_required") throw reauthorizationError(source, client.name);
    if (!waiting) {
      options.logger?.info("waiting for server to reconnect", { component: "bridge", server: source });
      waiting = true;
    }
    const outcome = await nextChange(client, deadline - Date.now(), options);
    if (outcome === "cancelled") throw cancelledError();
    if (outcome === "timeout") throw unavailableError(source);
  }
}

function nextChange(client: UpstreamClient, timeoutMs: number, options: UpstreamWaitOptions): Promise<WaitOutcome> {
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
