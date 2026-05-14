# CLI

```
npx @crabeye-ai/crabeye-mcp-bridge [command] [options]
```

## Commands

| Command | Description |
|---------|-------------|
| *(default)* | Start the bridge |
| `init` | Discover MCP client configs and set up the bridge |
| `restore` | Remove the bridge from client configs and restore originals |
| `credential set <key> [value]` | Store a credential (plain string, `--json` for typed, or pipe stdin) |
| `credential get <key>` | Retrieve a credential (`--show-secret` to unmask) |
| `credential delete <key>` | Delete a stored credential |
| `credential list` | List all stored credential keys |
| `auth <server>` | Run OAuth flow for an upstream — see [docs/auth.md](auth.md#oauth) |
| `auth --list` (or bare `auth`) | Show OAuth status per server |
| `auth --remove <server>` | Delete stored OAuth credentials for a server (local only) |
| `daemon start` \| `stop` \| `status` \| `restart` | Manage the per-user [STDIO manager](stdio-manager.md) process |

## Options (bridge mode)

| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Path to config file (or set `MCP_BRIDGE_CONFIG`) |
| `--validate` | Validate config and list upstream servers, then exit |
| `--stats` | Include `session_stats` in `search_tools` responses (always logged to stderr) |
| `--discovery-mode <mode>` | How searched tools are surfaced: `search`, `tools_list`, or `both` (default) |
| `-V, --version` | Print version |
| `-h, --help` | Print help |

## `init`

Scans for MCP client config files (Claude Desktop, Cursor, VS Code Copilot, Windsurf, Zed), lets you select which ones the bridge should use, and optionally injects the bridge entry into those configs.

```
$ npx @crabeye-ai/crabeye-mcp-bridge init
Scanning for MCP config files...

? Select config files to use with the bridge:
  [x] Claude Desktop  ~/.claude/claude_desktop_config.json
  [x] Cursor           ~/.cursor/mcp.json
  [ ] VS Code Copilot  ~/Library/Application Support/Code/User/settings.json

Saved config to ~/.crabeye-mcp-bridge/config.json

? Add bridge entry to selected client configs? (Y/n) y
  Updated ~/.claude/claude_desktop_config.json
  Updated ~/.cursor/mcp.json

Done! Run `crabeye-mcp-bridge` to start.
```

After `init`, you can start the bridge without `--config` — it reads the saved config paths automatically.

## `restore`

Reverses `init` by removing the bridge entry from client configs and renaming the upstream servers key back to its original name. All changes are done via JSONC-aware editing that preserves comments and formatting.

```
$ npx @crabeye-ai/crabeye-mcp-bridge restore
? Restore ~/.claude/claude_desktop_config.json? (Y/n) y
  Restored ~/.claude/claude_desktop_config.json
? Restore ~/.cursor/mcp.json? (Y/n) y
  Restored ~/.cursor/mcp.json
? Delete bridge config entirely? (y/N) n
Done.
```

## Validating your config

Use `--validate` to check your config file without starting the bridge:

```
$ npx @crabeye-ai/crabeye-mcp-bridge --config config.json --validate
Config OK — 3 upstream servers
  linear (stdio) [project management]
  github (stdio)
  sentry (streamable-http)
```

Exits with code 0 on success, code 1 on validation errors.
