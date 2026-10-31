import type { UpstreamLink } from "./instance-link.js";
import { InstanceUpstreamClient } from "./instance-upstream-client.js";
import type { UpstreamClient } from "./types.js";

export type UpstreamClientFactory = (name: string) => UpstreamClient;

/** A stand-in for an upstream the daemon connects, whatever its transport. */
export function defaultClientFactory(link: UpstreamLink): UpstreamClientFactory {
  return (name) => new InstanceUpstreamClient({ name, link });
}
