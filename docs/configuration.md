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

STDIO servers are started by the per-user [manager](stdio-manager.md), once for every bridge that uses them, so several AI clients share one process per server. A server starts with the environment of the AI client whose bridge first loaded the config, with its `env` on top, and never gets `MCP_BRIDGE_MASTER_KEY`; see [A STDIO server's environment](stdio-manager.md#a-stdio-servers-environment). `${credential:…}` values in `env` are filled in by the manager each time it starts the server. `cwd`, when set, must be an absolute path.

Each bridge talks to the manager over one connection, whatever servers it uses. `_bridge.daemon.heartbeatMs` (default `5000`) sets how often the bridge checks that the manager still answers, and `_bridge.daemon.rpcTimeoutMs` (default `30000`) how long it waits for the manager to answer when it connects and checks on it; a manager that misses three checks in a row or doesn't answer a check in time is replaced. See [Configuration knobs](stdio-manager.md#configuration-knobs).

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

`headers` are sent with every request to the server. The bridge ignores `Mcp-Method`, `Mcp-Name`, `Mcp-Param-*`, `Mcp-Protocol-Version` and `Mcp-Session-Id` here, because it sets those itself, and logs a warning naming any it ignored.

> **Deprecation.** The HTTP+SSE transport was superseded by Streamable HTTP in the MCP 2025-03-26 spec, and the MCP SDK now marks it deprecated. The bridge plans to remove `"sse"` support on **2027-07-28** (tracked in #201). If your server offers both, prefer `"streamable-http"` now.

HTTP and SSE upstreams are connected by the per-user manager, once for every bridge that uses them with the same master key, network settings and value of the variable a `clientSecret` names, so a server usually sees one connection however many AI clients are open; see [stdio-manager.md](stdio-manager.md#http-and-sse-upstreams). A bridge from crabeye 1.3.0 or earlier still connects its HTTP and SSE upstreams itself. A bridge starts the manager as soon as its config has an upstream.

### OAuth-authenticated HTTP servers

For servers that advertise OAuth, the minimal setup is just the `url` — run `crabeye-mcp-bridge auth <server>` once and crabeye takes it from there. The `_bridge.auth` block is only needed to override discovery or pin a pre-registered client:

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

Some upstream servers carry instructions the assistant should read before it uses their tools. Opt them in with `_bridge.passthrough`:

```json
{
  "upstreamMcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@anthropic/linear-mcp-server"],
      "_bridge": {
        "passthrough": true,
        "passthroughMaxBytes": 16384
      }
    }
  }
}
```

With `passthrough: true`, a search that returns the server marks it with `"has_instructions": true` once it has connected and sent instructions. A query with `include_instructions: true` gets the instructions themselves (see [how-it-works.md](how-it-works.md#discovering-providers)). The bridge's own instructions tell the assistant to ask for them before using such a server's tools. A server that isn't connected, or hasn't opted in, gets neither field. Edits to `passthrough` apply to the next search.

The old values `"instructions"`, `"tools"` and `"full"` still load and mean `true`. `"tools"` and `"full"` also log a warning: a search already returns a server's tools with their descriptions and input schemas.

`_bridge.passthroughMaxBytes` (optional, positive integer) caps a server's instructions in UTF-8 bytes. They are never longer than 256 KiB, which is also the cap when it is unset. Excess text is cut at a character boundary and `…(truncated)` is appended. The marker itself is not counted toward the cap.

Passthrough does not change which tools exist or how they run.

> **Trust note.** Enabling `passthrough` for a server lets that server's author write text the assistant reads as guidance. The bridge removes control, bidi, zero-width and other invisible characters and applies the byte cap, but it does not check the *content* for prompt injection. Only enable passthrough for servers you trust as much as the AI client itself.

## Config sources

The bridge reads upstream definitions from these top-level keys (in priority order, first wins on duplicate names):

1. `upstreamMcpServers`
2. `upstreamServers` (shorthand)
3. `servers` (VS Code Copilot)
4. `context_servers` (Zed)
5. `mcpServers`

Self-exclusion applies to `mcpServers` and `context_servers`: the bridge skips any entry that launches the bridge itself, so it doesn't start a copy of itself. An entry counts as the bridge when its command line runs the `crabeye-mcp-bridge` command, the `@crabeye-ai/crabeye-mcp-bridge` package (through `npx`, `pnpm dlx`, `bunx` and similar, including inside `cmd /c` or `sh -c`), or one of the bridge's own entry files. A server is not skipped just because a path, an option value (such as `--repo crabeye-ai/crabeye-mcp-bridge`) or a sentence in one of its arguments mentions `crabeye-mcp-bridge`. Each skipped entry is logged at info level when the bridge starts, and in the manager log when the config reloads; `--validate` lists it.

The bridge can't run as an upstream of another bridge: a bridge started that way exits with an error explaining why. Entries under the other keys are never skipped, so a bridge listed there fails to start.

The manager follows edits to your MCP config files and to `~/.crabeye-mcp-bridge/config.json`, and applies them to every AI client without a restart. A few settings, such as `_bridge.logFormat` and the `_bridge.daemon` settings, still need a restart; see [What happens when I edit my MCP config and save?](stdio-manager.md#what-happens-when-i-edit-my-mcp-config-and-save).

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
