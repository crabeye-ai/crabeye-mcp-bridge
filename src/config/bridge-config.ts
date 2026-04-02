import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { CREDENTIALS_DIR, BRIDGE_CONFIG_FILENAME } from "../constants.js";
import {
  ServerConfigSchema,
  GlobalBridgeConfigSchema,
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
