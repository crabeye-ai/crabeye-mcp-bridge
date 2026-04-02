import { readFile } from "node:fs/promises";
import { BridgeConfigSchema, type BridgeConfig } from "./schema.js";
import { loadBridgeOwnedConfig, type BridgeOwnedConfig } from "./bridge-config.js";
import { deepMerge } from "./deep-merge.js";
import { parseJsoncString } from "./jsonc.js";
import { ConfigError } from "./loader.js";

/** Keys we extract from client config files. */
const KNOWN_KEYS = [
  "mcpServers",
  "servers",
  "context_servers",
  "upstreamMcpServers",
  "upstreamServers",
  "_bridge",
] as const;

function pickKnownKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of KNOWN_KEYS) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

export interface MergedLoaderOptions {
  /** Explicit --config override path (highest priority). */
  configOverridePath?: string;
}

export interface MergedLoaderResult {
  config: BridgeConfig;
  watchPaths: string[];
}

export async function loadMergedConfig(
  options?: MergedLoaderOptions,
): Promise<MergedLoaderResult> {
  const bridgeOwned = await loadBridgeOwnedConfig();

  if (!bridgeOwned && !options?.configOverridePath) {
    throw new ConfigError(
      "No config found. Run 'crabeye-mcp-bridge init' to set up, or use --config <path>.",
    );
  }

  const watchPaths: string[] = [];
  const layers: Array<Record<string, unknown>> = [];

  // Layer 1: client configs from configPaths (in order, later wins)
  if (bridgeOwned) {
    for (const configPath of bridgeOwned.configPaths) {
      try {
        const raw = await readFile(configPath, "utf-8");
        const json = parseJsoncString(raw) as Record<string, unknown>;
        layers.push(pickKnownKeys(json));
        watchPaths.push(configPath);
      } catch {
        // Skip unreadable files — they may have been removed
      }
    }

    // Layer 2: bridge-owned overrides (without configPaths/modifiedConfigs metadata)
    layers.push(pickBridgeOverrides(bridgeOwned));
  }

  // Layer 3: explicit --config file (highest priority)
  if (options?.configOverridePath) {
    try {
      const raw = await readFile(options.configOverridePath, "utf-8");
      const json = parseJsoncString(raw) as Record<string, unknown>;
      layers.push(json);
      watchPaths.push(options.configOverridePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new ConfigError(
          `Config file not found: ${options.configOverridePath}`,
        );
      }
      throw new ConfigError(
        `Failed to read config file: ${options.configOverridePath} (${code ?? "unknown error"})`,
      );
    }
  }

  const merged = deepMerge(...layers);
  const result = BridgeConfigSchema.safeParse(merged);

  if (!result.success) {
    throw new ConfigError("Merged config validation failed");
  }

  return { config: result.data, watchPaths };
}

function pickBridgeOverrides(
  bridgeOwned: BridgeOwnedConfig,
): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  if (bridgeOwned.upstreamMcpServers)
    overrides.upstreamMcpServers = bridgeOwned.upstreamMcpServers;
  if (bridgeOwned.upstreamServers)
    overrides.upstreamServers = bridgeOwned.upstreamServers;
  if (bridgeOwned.servers) overrides.servers = bridgeOwned.servers;
  if (bridgeOwned._bridge) overrides._bridge = bridgeOwned._bridge;
  return overrides;
}
