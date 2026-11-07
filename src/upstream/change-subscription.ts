import { setTimeout as delay } from "node:timers/promises";
import { METHOD_NOT_FOUND, ProtocolError, type Client, type McpSubscription, type Tool } from "@modelcontextprotocol/client";
import { describeError, type Logger } from "../logging/index.js";

const RELISTEN_BASE_MS = 1_000;
const RELISTEN_MAX_MS = 30_000;

export interface KeepListeningOptions {
  logger: Logger;
  /** Whether `client` is still the connection to listen on. */
  isCurrent: () => boolean;
  /** Takes the tool list fetched after listening again, since changes may have been missed meanwhile. */
  onTools: (tools: Tool[]) => void;
  /** Waits `ms` before a try; defaults to a timer that doesn't keep the process alive. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Keeps a change subscription open for `client` on a 2026-07-28 connection.
 * When the subscription the SDK opened ends, other than by crabeye closing
 * it, listens again with the filter the SDK used; when the SDK couldn't open
 * one for a server that announces tool changes, listens for tool changes.
 * Waits longer after each failed try and after each subscription that ended
 * within the longest wait. Stops once `isCurrent` says the connection was
 * replaced or closed, or when the server says it has no such method.
 */
export function keepListening(client: Client, opts: KeepListeningOptions): void {
  const opened = client.autoOpenedSubscription;
  const filter = opened?.honoredFilter ?? (announcesToolChanges(client) ? { toolsListChanged: true } : undefined);
  if (filter === undefined) return;
  const sleep = opts.sleep ?? ((ms: number) => delay(ms, undefined, { ref: false }));

  const relisten = async (firstAttempt: number): Promise<void> => {
    for (let attempt = firstAttempt; ; attempt++) {
      await sleep(Math.min(RELISTEN_BASE_MS * 2 ** attempt, RELISTEN_MAX_MS));
      if (!opts.isCurrent()) return;
      let next: McpSubscription;
      try {
        next = await client.listen(filter);
      } catch (err) {
        opts.logger.debug("could not listen for changes again", { error: describeError(err) });
        if (err instanceof ProtocolError && err.code === METHOD_NOT_FOUND) return;
        continue;
      }
      opts.logger.info("listening for changes again");
      void watch(next, attempt + 1);
      client.listTools(undefined, { cacheMode: "refresh" }).then(
        ({ tools }) => {
          if (opts.isCurrent()) opts.onTools(tools);
        },
        (err: unknown) => opts.logger.debug("could not list tools after listening again", { error: describeError(err) }),
      );
      return;
    }
  };

  const watch = async (subscription: McpSubscription, attempt: number): Promise<void> => {
    const openedAt = Date.now();
    if ((await subscription.closed) === "local") return;
    await relisten(Date.now() - openedAt >= RELISTEN_MAX_MS ? 0 : attempt);
  };

  void (opened === undefined ? relisten(0) : watch(opened, 0));
}

function announcesToolChanges(client: Client): boolean {
  return client.getProtocolEra() === "modern" && client.getServerCapabilities()?.tools?.listChanged === true;
}
