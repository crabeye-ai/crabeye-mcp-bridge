import type { Logger } from "../logging/index.js";

export function warnSafely(logger: Logger | undefined, message: string): void {
  try {
    logger?.warn(message, { component: "credential_store" });
  } catch {
    // ignore
  }
}
