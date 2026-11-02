import type { Lease, SharedUpstream } from "./upstream-pool.js";
import type { WaitableClient } from "../../server/upstream-wait.js";
import { removedError } from "../../upstream/call-errors.js";
import type { StatusChangeCallback } from "../../upstream/types.js";

/** What waiting for a hosted upstream to connect, and then calling it, needs to see of it. */
export type HostedView = WaitableClient & Pick<SharedUpstream, "callTool">;

export function hostedView(name: string, upstream: SharedUpstream): HostedView {
  return {
    name,
    get status() {
      return upstream.status;
    },
    retryNow: async () => {
      await upstream.retry().catch(() => {});
    },
    onStatusChange: (callback: StatusChangeCallback) => {
      let previous = upstream.status;
      return upstream.subscribe({
        onSnapshot: ({ status }) => {
          if (status === previous) return;
          const event = { previous, current: status };
          previous = status;
          callback(event);
        },
        onLog: () => {},
      });
    },
    callTool: (params, options) => upstream.callTool(params, options),
  };
}

/**
 * Takes a slot under the limit of the lease `name` has, waiting under its
 * replacement's when it is replaced meanwhile; refuses the call as removed
 * once `name` is gone, or still has the lease that was released.
 */
export async function takeSlotFor(name: string, leaseOf: (name: string) => Lease | undefined, signal: AbortSignal): Promise<void> {
  let released: Lease | undefined;
  for (;;) {
    const lease = leaseOf(name);
    if (lease === undefined || lease === released) throw removedError(name);
    if ((await lease.takeSlot(signal)) === "granted") return;
    released = lease;
  }
}
