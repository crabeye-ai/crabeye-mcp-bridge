import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { BRIDGE_CONFIG_FILENAME, CREDENTIALS_DIR, DAEMON_SHUTDOWN_MARGIN_MS, DEFAULT_KILL_GRACE_MS } from "../constants.js";
import {
  ServerConfigSchema,
  GlobalBridgeConfigSchema,
  DaemonConfigSchema,
  type DaemonConfig,
} from "./schema.js";
import { parseJsoncString } from "./jsonc.js";

export const BridgeOwnedConfigSchema = z.object({
  configPaths: z.array(z.string()).default([]),
  modifiedConfigs: z.array(z.string()).default([]),
  upstreamMcpServers: z.record(z.string(), ServerConfigSchema).optional(),
  upstreamServers: z.record(z.string(), ServerConfigSchema).optional(),
  servers: z.record(z.string(), ServerConfigSchema).optional(),
  _bridge: GlobalBridgeConfigSchema.partial().optional(),
});

export type BridgeOwnedConfig = z.infer<typeof BridgeOwnedConfigSchema>;

export function getBridgeConfigPath(): string {
  return join(homedir(), CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME);
}

export async function loadBridgeOwnedConfig(): Promise<BridgeOwnedConfig | null> {
  let raw: string;
  try {
    raw = await readFile(getBridgeConfigPath(), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }

  const json = parseJsoncString(raw);
  return BridgeOwnedConfigSchema.parse(json);
}

export async function loadDaemonConfig(): Promise<DaemonConfig> {
  const config = await loadBridgeOwnedConfig().catch(() => null);
  return DaemonConfigSchema.parse(config?._bridge?.daemon ?? {});
}

export async function loadDaemonShutdownWaitMs(): Promise<number> {
  const killGraceMs = await loadDaemonConfig().then(
    (config) => config.killGraceMs,
    () => DEFAULT_KILL_GRACE_MS,
  );
  return killGraceMs + DAEMON_SHUTDOWN_MARGIN_MS;
}

export async function saveBridgeOwnedConfig(config: BridgeOwnedConfig): Promise<void> {
  const filePath = getBridgeConfigPath();
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(tmpPath, filePath);
}
