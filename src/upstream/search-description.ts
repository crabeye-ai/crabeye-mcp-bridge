import { renderServerList } from "../server/server-list.js";
import type { InstanceLink } from "./instance-link.js";

export type DescriptionLink = Pick<InstanceLink, "description" | "isAttached" | "isDown" | "upstreamNames">;

/**
 * What the bridge adds to the end of the `search_tools` description: the
 * manager's text while attached. Otherwise the servers the manager last
 * reported, or before the first attach the bridge's own, without categories:
 * as not connected while the manager can't be reached, and as starting
 * otherwise.
 */
export function currentSearchDescription(link: DescriptionLink, configNames: readonly string[]): string {
  const description = link.description();
  if (link.isAttached && description !== undefined) return description;
  const names = description === undefined ? configNames : link.upstreamNames();
  const status = link.isDown ? "disconnected" : "connecting";
  return renderServerList(names.map((name) => ({ name, status })));
}
