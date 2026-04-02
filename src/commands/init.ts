import { readFile, writeFile } from "node:fs/promises";
import { modify, applyEdits, type ModificationOptions } from "jsonc-parser";
import { APP_NAME } from "../constants.js";
import { discoverMcpConfigs } from "../config/discovery.js";
import {
  loadBridgeOwnedConfig,
  saveBridgeOwnedConfig,
  type BridgeOwnedConfig,
} from "../config/bridge-config.js";

/** Keys that hold MCP server definitions in client configs. */
const SERVER_KEYS = ["mcpServers", "servers", "context_servers"] as const;

/** Map from a server key to its upstream variant. */
const UPSTREAM_KEY_MAP: Record<string, string> = {
  mcpServers: "upstreamMcpServers",
  servers: "upstreamServers",
  context_servers: "upstreamServers",
};

const JSONC_FORMAT: ModificationOptions = {
  formattingOptions: {
    tabSize: 2,
    insertSpaces: true,
  },
};

const BRIDGE_ENTRY = {
  command: "npx",
  args: ["-y", `@crabeye-ai/${APP_NAME}`],
};

export async function runInit(): Promise<void> {
  const { default: checkbox } = await import("@inquirer/checkbox");
  const { default: confirm } = await import("@inquirer/confirm");

  process.stderr.write("Scanning for MCP config files...\n\n");

  const discovered = await discoverMcpConfigs();

  if (discovered.length === 0) {
    process.stderr.write(
      "No MCP config files found.\nUse --config <path> to specify a config file manually.\n",
    );
    return;
  }

  // Load existing bridge config to preserve overrides and pre-check paths
  const existing = await loadBridgeOwnedConfig();
  const previousPaths = new Set(existing?.configPaths ?? []);

  const selected = await checkbox<string>({
    message: "Select config files to use with the bridge:",
    choices: discovered.map(({ clientName, path }) => ({
      name: `${clientName}  ${path}`,
      value: path,
      checked: previousPaths.has(path),
    })),
  });

  if (selected.length === 0) {
    process.stderr.write("No config files selected.\n");
    return;
  }

  // Save bridge config — preserve existing overrides, only update configPaths
  const bridgeConfig: BridgeOwnedConfig = {
    ...(existing ?? { configPaths: [], modifiedConfigs: [] }),
    configPaths: selected,
  };

  const inject = await confirm({
    message: "Add bridge entry to selected client configs?",
    default: true,
  });

  if (inject) {
    const modifiedConfigs = new Set(bridgeConfig.modifiedConfigs);

    for (const configPath of selected) {
      try {
        const updated = await injectBridgeEntry(configPath);
        if (updated) {
          modifiedConfigs.add(configPath);
          process.stderr.write(`  Updated ${configPath}\n`);
        } else {
          process.stderr.write(`  Skipped ${configPath} (bridge entry already present)\n`);
        }
      } catch (err) {
        process.stderr.write(
          `  Failed to update ${configPath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }

    bridgeConfig.modifiedConfigs = [...modifiedConfigs];
  }

  await saveBridgeOwnedConfig(bridgeConfig);
  process.stderr.write(
    `\nSaved config to ~/.${APP_NAME}/config.json\n`,
  );
  process.stderr.write(`Done! Run \`${APP_NAME}\` to start.\n`);
}

/**
 * Inject the bridge entry into a client config file.
 *
 * 1. Find the server key (mcpServers, servers, etc.)
 * 2. Rename it to the upstream variant
 * 3. Add a new server key with only the bridge entry
 *
 * Returns true if the file was modified, false if bridge entry was already present.
 */
async function injectBridgeEntry(configPath: string): Promise<boolean> {
  const raw = await readFile(configPath, "utf-8");

  // Find which server key exists and contains entries
  const { parse } = await import("jsonc-parser");
  const parsed = parse(raw, [], { allowTrailingComma: true }) as Record<string, unknown>;

  // Check if bridge is already injected
  for (const key of SERVER_KEYS) {
    const servers = parsed[key] as Record<string, unknown> | undefined;
    if (servers && APP_NAME in servers) {
      return false;
    }
  }

  // Find the server key to transform
  let serverKey: string | undefined;
  for (const key of SERVER_KEYS) {
    if (parsed[key] && typeof parsed[key] === "object") {
      serverKey = key;
      break;
    }
  }

  if (!serverKey) {
    // No server key found — just add the bridge entry under mcpServers
    let content = raw;
    const edits = modify(content, ["mcpServers"], { [APP_NAME]: BRIDGE_ENTRY }, JSONC_FORMAT);
    content = applyEdits(content, edits);
    await writeFile(configPath, content, "utf-8");
    return true;
  }

  const upstreamKey = UPSTREAM_KEY_MAP[serverKey] ?? `upstream${serverKey.charAt(0).toUpperCase()}${serverKey.slice(1)}`;

  // We need to:
  // 1. Add the upstream key with the current server entries
  // 2. Replace the server key with just the bridge entry
  let content = raw;
  const serverEntries = parsed[serverKey];

  // Step 1: add the upstream key with the existing servers
  const edits1 = modify(content, [upstreamKey], serverEntries, JSONC_FORMAT);
  content = applyEdits(content, edits1);

  // Step 2: replace the server key with the bridge entry only
  const edits2 = modify(content, [serverKey], { [APP_NAME]: BRIDGE_ENTRY }, JSONC_FORMAT);
  content = applyEdits(content, edits2);

  await writeFile(configPath, content, "utf-8");
  return true;
}
