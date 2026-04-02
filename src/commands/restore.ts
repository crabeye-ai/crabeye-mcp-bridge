import { readFile, writeFile } from "node:fs/promises";
import { modify, applyEdits, parse, type ModificationOptions } from "jsonc-parser";
import { APP_NAME } from "../constants.js";
import {
  loadBridgeOwnedConfig,
  saveBridgeOwnedConfig,
  getBridgeConfigPath,
} from "../config/bridge-config.js";

/** Map from upstream key back to its original server key. */
const UPSTREAM_TO_ORIGINAL: Record<string, string> = {
  upstreamMcpServers: "mcpServers",
  upstreamServers: "servers",
};

const JSONC_FORMAT: ModificationOptions = {
  formattingOptions: {
    tabSize: 2,
    insertSpaces: true,
  },
};

export async function runRestore(): Promise<void> {
  const { default: confirm } = await import("@inquirer/confirm");

  const bridgeConfig = await loadBridgeOwnedConfig();

  if (!bridgeConfig) {
    process.stderr.write("No bridge config found. Nothing to restore.\n");
    return;
  }

  if (bridgeConfig.modifiedConfigs.length === 0) {
    process.stderr.write(
      "No client configs were modified by init. Nothing to restore.\n",
    );
  } else {
    for (const configPath of bridgeConfig.modifiedConfigs) {
      const proceed = await confirm({
        message: `Restore ${configPath}?`,
        default: true,
      });

      if (!proceed) {
        process.stderr.write(`  Skipped ${configPath}\n`);
        continue;
      }

      try {
        const restored = await restoreClientConfig(configPath);
        if (restored) {
          process.stderr.write(`  Restored ${configPath}\n`);
        } else {
          process.stderr.write(`  Skipped ${configPath} (no bridge entry found)\n`);
        }
      } catch (err) {
        process.stderr.write(
          `  Failed to restore ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    // Clear modifiedConfigs
    bridgeConfig.modifiedConfigs = [];
    await saveBridgeOwnedConfig(bridgeConfig);
  }

  const deleteBridgeConfig = await confirm({
    message: "Delete bridge config entirely?",
    default: false,
  });

  if (deleteBridgeConfig) {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(getBridgeConfigPath());
      process.stderr.write("Bridge config deleted.\n");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write(
          `Failed to delete bridge config: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  process.stderr.write("Done.\n");
}

/**
 * Restore a client config by removing the bridge entry and renaming
 * the upstream key back to the original server key.
 *
 * Logic:
 * 1. Find which key contains the bridge entry — that's the "original key"
 * 2. Find which upstream key exists in the file
 * 3. Remove the original key (bridge-only)
 * 4. Rename the upstream key back to the original key
 */
async function restoreClientConfig(configPath: string): Promise<boolean> {
  const raw = await readFile(configPath, "utf-8");
  const parsed = parse(raw, [], { allowTrailingComma: true }) as Record<string, unknown>;

  // Step 1: find the key containing the bridge entry
  let originalKey: string | undefined;
  for (const [key, value] of Object.entries(parsed)) {
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      APP_NAME in (value as Record<string, unknown>)
    ) {
      originalKey = key;
      break;
    }
  }

  if (!originalKey) {
    return false;
  }

  // Step 2: find the upstream key
  let upstreamKey: string | undefined;
  let upstreamEntries: unknown;
  for (const [key, origKey] of Object.entries(UPSTREAM_TO_ORIGINAL)) {
    if (key in parsed) {
      upstreamKey = key;
      upstreamEntries = parsed[key];
      break;
    }
  }

  let content = raw;

  if (upstreamKey && upstreamEntries) {
    // Step 3: replace the original key with upstream entries
    const edits1 = modify(content, [originalKey], upstreamEntries, JSONC_FORMAT);
    content = applyEdits(content, edits1);

    // Step 4: remove the upstream key
    const edits2 = modify(content, [upstreamKey], undefined, JSONC_FORMAT);
    content = applyEdits(content, edits2);
  } else {
    // No upstream key — just remove the bridge entry from the original key
    const edits = modify(content, [originalKey, APP_NAME], undefined, JSONC_FORMAT);
    content = applyEdits(content, edits);
  }

  await writeFile(configPath, content, "utf-8");
  return true;
}
