import { vi } from "vitest";

/** Writes again until `check` passes, so an edit made before a watcher is ready still lands. */
export async function rewriteUntil(write: () => Promise<unknown>, check: () => void | Promise<void>): Promise<void> {
  await vi.waitFor(
    async () => {
      await write();
      await check();
    },
    { timeout: 10_000, interval: 200 },
  );
}
