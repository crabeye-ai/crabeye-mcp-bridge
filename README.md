# crabeye-mcp-bridge

Aggregates multiple MCP servers behind a single STDIO interface. Point your AI assistant at one bridge instead of configuring each MCP server individually.

Requires Node.js >= 22.

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

The bridge starts each configured upstream server, discovers their tools, and exposes them through two meta-tools:

- **`search_tools`** — Search for tools by name, description, or provider. Results are auto-enabled for use.
- **`run_tool`** — Execute any discovered tool by its namespaced name (e.g. `linear__create_issue`).

The AI assistant calls `search_tools` automatically when it detects a relevant intent, then uses `run_tool` or calls the auto-enabled tools directly.

When `search_tools` gets called, the AI assistant receives the available tools and the schema for how to call them. When the search is completed the bridge will also directly expose the searched tools to the AI assistant. Some assistants don't refresh the tools available for the session, so they might still not see the newly exposed tools, but they can still make calls through the `run_tool` tool and they will get executed exactly as if done directly on the original tool.

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
