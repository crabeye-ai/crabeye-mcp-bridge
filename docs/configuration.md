# Configuration

## STDIO servers

Servers that run as local subprocesses:

```json
{
  "upstreamMcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./server.js"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

STDIO upstreams are routed through the [STDIO manager](stdio-manager.md) so multiple bridges can share a single subprocess per upstream.

## HTTP servers

Remote servers accessible via HTTP:

```json
{
  "upstreamMcpServers": {
    "remote-server": {
      "url": "https://mcp.example.com/sse",
      "type": "sse",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

`type` defaults to `"streamable-http"`. Use `"sse"` for servers that use the legacy HTTP+SSE transport.

> **Deprecation.** The HTTP+SSE transport was superseded by Streamable HTTP in the MCP 2025-03-26 spec, and the MCP SDK now marks it deprecated. The bridge plans to remove `"sse"` support on **2027-07-28** (tracked in #201). If your server offers both, prefer `"streamable-http"` now.

HTTP/SSE upstreams are **not** routed through the manager; each bridge connects directly.

### OAuth-authenticated HTTP servers

For servers that advertise OAuth, the minimal setup is just the `url` — run `crabeye-mcp-bridge auth <server>` once and the bridge takes it from there. The `_bridge.auth` block is only needed to override discovery or pin a pre-registered client:

```json
{
  "upstreamMcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/mcp"
    },
    "notion": {
      "url": "https://mcp.notion.com/mcp",
      "_bridge": {
        "auth": {
          "type": "oauth2",
          "clientId": "pre-registered-client-id",
          "scopes": ["read", "write"],
          "redirectPort": 18234,
          "clientSecret": "${NOTION_OAUTH_SECRET}"
        }
      }
    }
  }
}
```

See [docs/auth.md](auth.md#oauth) for the full OAuth flow, confidential-client setup, and platform notes.

## Categories

Assign a category to a server so tools can be discovered by domain rather than server name:

```json
{
  "upstreamMcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@anthropic/linear-mcp-server"],
      "_bridge": {
        "category": "project management"
      }
    },
    "figma": {
      "command": "npx",
      "args": ["-y", "@anthropic/figma-mcp-server"],
      "_bridge": {
        "category": "design"
      }
    }
  }
}
```

The assistant can then search by category: `{ "queries": [{ "category": "design" }] }`. Category matching uses prefix match by default, so `"project"` matches `"project management"`. Use `regex:` prefix for pattern matching.

## Context passthrough

Some upstream servers carry instructions or tool documentation the model needs from the very first turn — opt them in with `_bridge.passthrough`:

```json
{
  "upstreamMcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@anthropic/linear-mcp-server"],
      "_bridge": {
        "passthrough": "instructions"
      }
    },
    "filesystem": {
      "command": "node",
      "args": ["./fs-server.js"],
      "_bridge": {
        "passthrough": "tools",
        "passthroughMaxBytes": 16384
      }
    }
  }
}
```

Levels:

| Value | What's appended to bridge instructions |
|-------|----------------------------------------|
| `false` / unset (default) | Nothing. Tools stay hidden behind `search_tools`. |
| `"instructions"` | The upstream's `initialize.instructions` text under `## <configKey>`. |
| `"tools"` | Instructions plus a `### Tools` list with each namespaced tool name and description. |
| `"full"` | Same as `"tools"` plus each tool's `inputSchema` as compact JSON. |

The literal `true` is not accepted — pick a level explicitly. Headings use the config key (e.g. `linear`), which is also the namespace prefix the model uses when invoking tools (`linear__create_issue`). Tools filtered out by `_bridge.tools` allow/deny do not appear in the rendered list.

`_bridge.passthroughMaxBytes` (optional, positive integer) caps the per-server rendered block in UTF-8 bytes. Excess content is truncated at a codepoint boundary and `…(truncated)` is appended. The marker itself is not counted toward the cap.

Passthrough does not change tool exposure or routing — `tools/list` and `search_tools` behave exactly as before. Toggling `passthrough` at runtime regenerates the bridge instructions for the next client `initialize`; existing sessions are unaffected because MCP has no mid-session push for instructions.

> **Trust note.** Enabling `passthrough` for a server lets that server's author influence your LLM's system prompt — its `instructions` text and tool descriptions are interpolated verbatim. The bridge sanitises control / bidi / zero-width characters and applies a per-server byte cap, but it does not validate the *content* against prompt-injection. Only enable passthrough for servers you trust as much as the LLM client itself.

## Config sources

The bridge reads upstream definitions from these top-level keys (in priority order, first wins on duplicate names):

1. `upstreamMcpServers`
2. `upstreamServers` (shorthand)
3. `servers` (VS Code Copilot)
4. `context_servers` (Zed)
5. `mcpServers`

Self-exclusion applies to `mcpServers` and `context_servers`: the bridge skips any entry that launches the bridge itself, so it doesn't start a copy of itself. An entry counts as the bridge when its command line runs the `crabeye-mcp-bridge` command, the `@crabeye-ai/crabeye-mcp-bridge` package (through `npx`, `pnpm dlx`, `bunx` and similar, including inside `cmd /c` or `sh -c`), or one of the bridge's own entry files. A server is not skipped just because a path, an option value (such as `--repo crabeye-ai/crabeye-mcp-bridge`) or a sentence in one of its arguments mentions `crabeye-mcp-bridge`. Each skipped entry is logged at info level when the config loads or reloads, and `--validate` lists it.

The bridge can't run as an upstream of another bridge: a bridge started that way exits with an error explaining why. Entries under the other keys are never skipped, so a bridge listed there fails to start.

## Supported clients in `init`

The `init` command scans for these config files (first existing path per client wins):

| Client | Mode | Default location |
|--------|------|------------------|
| Claude Desktop | inject | `~/.claude/claude_desktop_config.json` (or `~/.claude.json`) |
| Cursor | inject | `~/.cursor/mcp.json` |
| VS Code Copilot | inject | `~/Library/Application Support/Code/User/settings.json` (macOS); platform equivalents elsewhere |
| Windsurf | inject | `~/.codeium/windsurf/mcp_config.json` |
| Zed | inject | `~/.config/zed/settings.json` |
| Cline | inject | `…/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` |
| Roo Code | inject | `…/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` — tries this first, then `cline_mcp_settings.json` for legacy Roo Cline layouts |
| opencode | detect-only | `~/.config/opencode/opencode.json` |
| Continue.dev | detect-only | `~/.continue/config.json`, `~/.continue/config.yaml`, or `~/.continue/mcpServers/` |

**Inject** clients get the bridge wired in automatically — `init` renames the client's `mcpServers` (or equivalent) to `upstreamMcpServers` and writes a single bridge entry. `restore` reverses this.

**Detect-only** clients use a config shape that doesn't fit the rename-and-inject pipeline (opencode's `mcp` key holds a divergent server entry shape; Continue.dev splits MCP across an array key, YAML files, or a directory). `init` lists them and prints a manual snippet to stderr; the file itself is not modified, and `restore` ignores them.

Only the per-user HOME locations are scanned. Workspace-level configs (`./opencode.json`, `.roo/mcp.json`, `.continue/`) are not auto-detected — point `--config` at them directly if needed.
