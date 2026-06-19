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
    choices: discovered.map(({ clientName, path, mode }) => ({
      name: mode === "detect-only"
        ? `${clientName}  ${path}  (detect-only)`
        : `${clientName}  ${path}`,
      value: path,
      checked: previousPaths.has(path),
    })),
  });

  if (selected.length === 0) {
    process.stderr.write("No config files selected.\n");
    return;
  }

  // Detect-only configs use a schema the bridge can't consume; keeping them
  // out of configPaths avoids a merged-loader read against an unparseable file.
  const selectedSet = new Set(selected);
  const selectedEntries = discovered.filter((e) => selectedSet.has(e.path));
  const injectableEntries = selectedEntries.filter((e) => e.mode === "inject");
  const detectOnlyEntries = selectedEntries.filter((e) => e.mode === "detect-only");

  const bridgeConfig: BridgeOwnedConfig = {
    ...(existing ?? { configPaths: [], modifiedConfigs: [] }),
    configPaths: injectableEntries.map((e) => e.path),
  };

  // Detect-only snippets are not gated on the inject confirm — the user picked
  // them precisely to learn how to wire them up manually.
  for (const entry of detectOnlyEntries) {
    printDetectOnlySnippet(entry.clientName, entry.path);
  }

  const inject = injectableEntries.length > 0
    ? await confirm({
        message: "Add bridge entry to selected client configs?",
        default: true,
      })
    : false;

  if (inject) {
    const modifiedConfigs = new Set(bridgeConfig.modifiedConfigs);

    for (const entry of injectableEntries) {
      const configPath = entry.path;
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

const OPENCODE_SNIPPET = `{
  "mcp": {
    "${APP_NAME}": {
      "type": "local",
      "command": ["npx", "-y", "@crabeye-ai/${APP_NAME}"],
      "enabled": true
    }
  }
}`;

const CONTINUE_DEV_HINT =
  "Continue.dev's MCP support is still evolving (legacy JSON array shape, " +
  "newer per-file YAML). See https://docs.continue.dev/customize/mcp-tools " +
  "for the current schema and add an entry pointing at " +
  `\`npx -y @crabeye-ai/${APP_NAME}\`.`;

/**
 * Print a manual-setup snippet for a harness whose config schema doesn't fit
 * the rename-and-inject pipeline. Does not modify the file.
 */
function printDetectOnlySnippet(clientName: string, configPath: string): void {
  process.stderr.write(
    `  ${clientName} cannot be auto-injected — its config schema doesn't fit the rename pipeline.\n`,
  );
  process.stderr.write(`  Edit ${configPath} manually:\n\n`);

  if (clientName === "opencode") {
    process.stderr.write(`    ${OPENCODE_SNIPPET.replaceAll("\n", "\n    ")}\n\n`);
    return;
  }

  if (clientName === "Continue.dev") {
    process.stderr.write(`    ${CONTINUE_DEV_HINT}\n\n`);
    return;
  }

  // Fallback for any future detect-only harness without a tailored snippet.
  process.stderr.write(
    `    Add an entry pointing at \`npx -y @crabeye-ai/${APP_NAME}\`.\n\n`,
  );
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
