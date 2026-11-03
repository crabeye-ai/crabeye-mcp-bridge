import type * as fs from "node:fs";

const watchers: Array<{ dir: string; closed: boolean }> = [];

/**
 * `node:fs` with a `watch` that records each directory it watches, for
 * `vi.mock("node:fs", async (importOriginal) => (await import(".../fs-watch-tracker.js")).trackWatch(await importOriginal()))`.
 */
export function trackWatch(actual: typeof fs): typeof fs & { default: typeof fs } {
  const watch = ((dir: string, ...rest: unknown[]) => {
    const watcher = (actual.watch as (...args: unknown[]) => fs.FSWatcher)(dir, ...rest);
    const entry = { dir, closed: false };
    watchers.push(entry);
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      entry.closed = true;
      close();
    };
    return watcher;
  }) as typeof actual.watch;
  return { ...actual, watch, default: { ...actual, watch } };
}

/** Whether a watch `trackWatch` recorded on `dir` is still open. */
export const watching = (dir: string): boolean => watchers.some((watcher) => watcher.dir === dir && !watcher.closed);
