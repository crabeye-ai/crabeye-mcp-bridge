import { stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export type DiscoveryMode = "inject" | "detect-only";

export interface McpConfigEntry {
  clientName: string;
  path: string;
  mode: DiscoveryMode;
}

export interface KnownLocation {
  clientName: string;
  paths: string[];
  mode: DiscoveryMode;
  /**
   * Treat a directory match as presence. Default: file presence only.
   * Used for Continue.dev where the per-server YAML directory may be the
   * only signal that the user has MCP configured.
   */
  acceptDirectory?: boolean;
}

function vscodeUserDir(home: string, os: NodeJS.Platform): string {
  switch (os) {
    case "darwin":
      return join(home, "Library", "Application Support", "Code", "User");
    case "win32":
      return join(home, "AppData", "Roaming", "Code", "User");
    default:
      return join(home, ".config", "Code", "User");
  }
}

function getKnownLocations(): KnownLocation[] {
  const home = homedir();
  const os = platform();

  const vscodeUser = vscodeUserDir(home, os);
  const vscodeSettingsPath = join(vscodeUser, "settings.json");
  const clineSettings = join(
    vscodeUser,
    "globalStorage",
    "saoudrizwan.claude-dev",
    "settings",
    "cline_mcp_settings.json",
  );
  const rooSettingsDir = join(
    vscodeUser,
    "globalStorage",
    "rooveterinaryinc.roo-cline",
    "settings",
  );

  return [
    {
      clientName: "Claude Desktop",
      paths: [
        join(home, ".claude", "claude_desktop_config.json"),
        join(home, ".claude.json"),
      ],
      mode: "inject",
    },
    {
      clientName: "Cursor",
      paths: [join(home, ".cursor", "mcp.json")],
      mode: "inject",
    },
    {
      clientName: "VS Code Copilot",
      paths: [vscodeSettingsPath],
      mode: "inject",
    },
    {
      clientName: "Windsurf",
      paths: [join(home, ".codeium", "windsurf", "mcp_config.json")],
      mode: "inject",
    },
    {
      clientName: "Zed",
      paths: [join(home, ".config", "zed", "settings.json")],
      mode: "inject",
    },
    {
      clientName: "Cline",
      paths: [clineSettings],
      mode: "inject",
    },
    {
      clientName: "Roo Code",
      paths: [
        join(rooSettingsDir, "mcp_settings.json"),
        join(rooSettingsDir, "cline_mcp_settings.json"),
      ],
      mode: "inject",
    },
    {
      clientName: "opencode",
      paths: [join(home, ".config", "opencode", "opencode.json")],
      mode: "detect-only",
    },
    {
      clientName: "Continue.dev",
      paths: [
        join(home, ".continue", "config.json"),
        join(home, ".continue", "config.yaml"),
        join(home, ".continue", "mcpServers"),
      ],
      mode: "detect-only",
      acceptDirectory: true,
    },
  ];
}

async function pathExists(path: string, acceptDirectory: boolean): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() || (acceptDirectory && info.isDirectory());
  } catch {
    return false;
  }
}

export async function discoverMcpConfigs(
  locations: KnownLocation[] = getKnownLocations(),
): Promise<McpConfigEntry[]> {
  const results: McpConfigEntry[] = [];

  for (const { clientName, paths, mode, acceptDirectory } of locations) {
    for (const path of paths) {
      if (await pathExists(path, acceptDirectory ?? false)) {
        results.push({ clientName, path, mode });
        break;
      }
    }
  }

  return results;
}
