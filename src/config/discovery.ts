import { access } from "node:fs/promises";
import { join } from "node:path";
import { homedir, platform } from "node:os";

export interface McpConfigEntry {
  clientName: string;
  path: string;
}

function getKnownLocations(): Array<{ clientName: string; paths: string[] }> {
  const home = homedir();
  const os = platform();

  const vscodeSettingsPath =
    os === "darwin"
      ? join(home, "Library", "Application Support", "Code", "User", "settings.json")
      : os === "win32"
        ? join(home, "AppData", "Roaming", "Code", "User", "settings.json")
        : join(home, ".config", "Code", "User", "settings.json");

  return [
    {
      clientName: "Claude Desktop",
      paths: [
        join(home, ".claude", "claude_desktop_config.json"),
        join(home, ".claude.json"),
      ],
    },
    {
      clientName: "Cursor",
      paths: [join(home, ".cursor", "mcp.json")],
    },
    {
      clientName: "VS Code Copilot",
      paths: [vscodeSettingsPath],
    },
    {
      clientName: "Windsurf",
      paths: [join(home, ".codeium", "windsurf", "mcp_config.json")],
    },
    {
      clientName: "Zed",
      paths: [join(home, ".config", "zed", "settings.json")],
    },
  ];
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function discoverMcpConfigs(): Promise<McpConfigEntry[]> {
  const locations = getKnownLocations();
  const results: McpConfigEntry[] = [];

  for (const { clientName, paths } of locations) {
    for (const path of paths) {
      if (await fileExists(path)) {
        results.push({ clientName, path });
        break; // only first match per client
      }
    }
  }

  return results;
}
