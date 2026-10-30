import { vi } from "vitest";
import type { UpstreamSnapshot } from "../../src/daemon/protocol.js";
import type { UpstreamLink, UpstreamView } from "../../src/upstream/instance-link.js";

/** Stands in for a bridge's instance link: tests send snapshots by hand. */
export class FakeInstanceLink implements UpstreamLink {
  isAttached = true;
  private readonly views = new Map<string, Set<UpstreamView>>();
  readonly snapshots = new Map<string, UpstreamSnapshot>();
  attach = vi.fn(async () => {});
  attachNow = vi.fn(async () => {});
  retry = vi.fn<(name: string) => Promise<UpstreamSnapshot>>(async (name) => {
    const snapshot = this.snapshots.get(name) ?? { name, status: "connected", tools: [] };
    this.send(snapshot);
    return snapshot;
  });
  callTool = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
  close = vi.fn(async () => {});

  watch(name: string, view: UpstreamView): () => void {
    const views = this.views.get(name) ?? new Set<UpstreamView>();
    this.views.set(name, views);
    views.add(view);
    return () => views.delete(view);
  }

  snapshot(name: string): UpstreamSnapshot | undefined {
    return this.snapshots.get(name);
  }

  send(snapshot: UpstreamSnapshot): void {
    this.snapshots.set(snapshot.name, snapshot);
    for (const view of this.views.get(snapshot.name) ?? []) view.onSnapshot(snapshot);
  }

  viewsOf(name: string): UpstreamView[] {
    return [...(this.views.get(name) ?? [])];
  }
}
