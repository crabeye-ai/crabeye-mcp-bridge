# Crabeye MCP Bridge

One MCP connection for all your tools — with discovery, namespacing, and execution policies.

Every MCP server you add to your AI assistant means another connection, another set of tool definitions injected into the context window, and no way to search or control them centrally. Wire up ten servers with a hundred tools each and your assistant is burning tokens on a thousand tool schemas before the conversation even starts — most of which it will never call.

crabeye-mcp-bridge consolidates all your upstream MCP servers behind a single STDIO interface and exposes exactly **two tools** to the assistant: `search_tools` and `run_tool`. Tools from every server are discovered, namespaced, and indexed at startup, but none of them touch the context window until the assistant actually searches for them. You can have a thousand tools ready to go without bloating the context, with fuzzy search to find them and per-tool execution policies to control what runs freely, what needs approval, and what is blocked.

```mermaid
%%{init: {'flowchart': {'nodeSpacing': 25, 'rankSpacing': 70}}}%%
flowchart LR
    classDef client fill:#dbeafe,stroke:#2563eb,stroke-width:2px
    classDef bridge fill:#ede9fe,stroke:#7c3aed,stroke-width:3px
    classDef server fill:#d1fae5,stroke:#059669,stroke-width:2px
    classDef more fill:#f1f5f9,stroke:#64748b,stroke-width:2px,stroke-dasharray:5 5

    A["AI Assistant<br/>(Claude, Cursor, Windsurf, ...)"]:::client
    A -- "1 STDIO connection<br/>2 tools exposed" --> B
    B["crabeye-mcp-bridge<br/>search_tools + run_tool"]:::bridge

    B -- STDIO --> C["Linear<br/>47 tools"]:::server
    B -- STDIO --> D["GitHub<br/>32 tools"]:::server
    B -- HTTP --> E["Slack<br/>28 tools"]:::server
    B -- SSE --> F["Sentry<br/>19 tools"]:::server
    B -.-> G["N more<br/>servers"]:::more
```

## Quick start

Say your MCP client config looks like this today:

```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@anthropic/linear-mcp-server"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic/github-mcp-server"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

To use the bridge, rename `mcpServers` to `upstreamMcpServers` and add the bridge as the only entry in `mcpServers`:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "npx",
      "args": ["-y", "@crabeye-ai/crabeye-mcp-bridge", "--config", "/path/to/this/file.json"]
    }
  },
  "upstreamMcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@anthropic/linear-mcp-server"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic/github-mcp-server"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

That's it. Your AI assistant now has access to all tools from all configured servers through a single connection. The bridge automatically excludes itself from `mcpServers` to avoid recursion, so pointing `--config` at the same file is safe.

The bridge also reads `servers` (VS Code Copilot) and `context_servers` (Zed) as input keys. On duplicate names, earlier sources win: `upstreamMcpServers` > `servers` > `context_servers` > `mcpServers`. Self-exclusion applies to `mcpServers` and `context_servers`.

Alternatively, you can add the bridge alongside your existing `mcpServers` entries without renaming anything:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "npx",
      "args": ["-y", "@crabeye-ai/crabeye-mcp-bridge", "--config", "/path/to/this/file.json"]
    },
    "linear": {
      "command": "npx",
      "args": ["-y", "@anthropic/linear-mcp-server"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic/github-mcp-server"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

The bridge will pick up the other servers from `mcpServers` automatically (excluding itself). This makes it easier to see at a glance in your client which MCP servers are configured. However, you'll want to disable the other MCP servers in your client so the assistant uses the bridge as the single entry point rather than calling them directly, otherwise it defeats the purpose of using this tool.

You can, of course, also use a completely different config file for the bridge. It will work as long as you add the bridge to your client's MCP config.

## How it works

On startup the bridge launches every configured upstream server, connects to it, and discovers its tools. Each tool is namespaced by server name (e.g. `linear__create_issue`, `github__list_repos`) so tools from different servers never collide.

Two meta-tools are exposed to the AI assistant:

- **`search_tools`** — Fuzzy-search across all discovered tools by name, description, or provider. Matching tools are automatically enabled for use.
- **`run_tool`** — Execute any discovered tool directly by its namespaced name (e.g. `linear__create_issue`).

The AI assistant calls `search_tools` automatically when it detects a relevant intent, then uses `run_tool` or calls the auto-enabled tools directly.

When `search_tools` is called, the assistant receives the matching tools and their input schemas. The bridge also directly exposes the searched tools to the assistant so they can be called natively. Some assistants don't refresh their tool list mid-session, so they may not see the newly exposed tools — but they can still call them through `run_tool` and the call is executed exactly as if made directly on the original tool.

## Examples

### Searching for tools

The assistant calls `search_tools` whenever it needs a capability it doesn't have yet. Queries are fuzzy-matched against tool names, descriptions, and providers:

```json
{
  "name": "search_tools",
  "arguments": {
    "queries": ["create issue"]
  }
}
```

The bridge returns matching tools with their full input schemas:

```json
{
  "tools": [
    {
      "tool_name": "linear__create_issue",
      "source": "linear",
      "description": "Create a new Linear issue",
      "input_schema": {
        "type": "object",
        "properties": {
          "title": { "type": "string" },
          "team": { "type": "string" },
          "description": { "type": "string" }
        },
        "required": ["title", "team"]
      }
    },
    {
      "tool_name": "github__create_issue",
      "source": "github",
      "description": "Create a GitHub issue",
      "input_schema": { "..." }
    }
  ],
  "auto_enabled": ["linear__create_issue", "github__create_issue"],
  "total": 2
}
```

The tools listed in `auto_enabled` are now directly callable by the assistant — no extra step needed.

### Running a tool directly

If the assistant already knows the namespaced name, it can skip the search and call `run_tool` directly:

```json
{
  "name": "run_tool",
  "arguments": {
    "name": "linear__create_issue",
    "arguments": {
      "title": "Fix login crash",
      "team": "Engineering",
      "description": "The app crashes on login when the session token is expired"
    }
  }
}
```

The response is passed through exactly as the upstream server returns it.

### Filtering by provider

Search for all tools from a specific server:

```json
{
  "name": "search_tools",
  "arguments": {
    "queries": ["list"],
    "providers": ["github"]
  }
}
```

Only tools from the `github` server matching "list" are returned.

### Regex search

For precise matching, prefix the query with `regex:`:

```json
{
  "name": "search_tools",
  "arguments": {
    "queries": ["regex:^list_"]
  }
}
```

This finds all tools whose name starts with `list_` — across every server.

## Configuration

### STDIO servers

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

### HTTP servers

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

`type` defaults to `"streamable-http"`. Use `"sse"` for servers that use Server-Sent Events transport.

### Authentication

Static credentials (API keys, tokens) can be passed via `env` or `headers` in the server config. OAuth is not yet supported.

### Tool policies

Control which tools can run automatically, require confirmation, or are blocked entirely. Three policy values:

- `"always"` — tool runs without confirmation (default)
- `"prompt"` — user is asked to approve each call via MCP elicitation
- `"never"` — tool is disabled and cannot be called

Policies cascade in this order (first match wins):

1. Per-tool (`_bridge.tools.<toolName>`)
2. Per-server (`_bridge.toolPolicy`)
3. Global (`_bridge.toolPolicy`)
4. Default: `"always"`

```json
{
  "upstreamMcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@anthropic/linear-mcp-server"],
      "_bridge": {
        "toolPolicy": "prompt",
        "tools": {
          "list_issues": "always",
          "delete_issue": "never"
        }
      }
    }
  },
  "_bridge": {
    "toolPolicy": "always"
  }
}
```

In this example, all Linear tools require confirmation except `list_issues` (runs freely) and `delete_issue` (blocked). Tools from other servers use the global default (`"always"`).

## CLI

```
npx @crabeye-ai/crabeye-mcp-bridge --config <path>
```

| Flag | Description |
|------|-------------|
| `-c, --config <path>` | Path to config file (required, or set `MCP_BRIDGE_CONFIG`) |
| `-V, --version` | Print version |
| `-h, --help` | Print help |

## License

MIT
