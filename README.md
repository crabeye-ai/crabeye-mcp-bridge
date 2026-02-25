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

To use the bridge, rename `mcpServers` to `mcpUpstreams` and add the bridge as the only entry in `mcpServers`:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "npx",
      "args": ["-y", "crabeye-mcp-bridge", "--config", "/path/to/this/file.json"]
    }
  },
  "mcpUpstreams": {
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

Alternatively, you can add the bridge alongside your existing `mcpServers` entries without renaming anything:

```json
{
  "mcpServers": {
    "bridge": {
      "command": "npx",
      "args": ["-y", "crabeye-mcp-bridge", "--config", "/path/to/this/file.json"]
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

The bridge will pick up the other servers from `mcpServers` automatically (excluding itself). However, you'll want to disable the other MCP servers in your client so the assistant uses the bridge as the single entry point rather than calling them directly.

## How it works

The bridge starts each configured upstream server, discovers their tools, and exposes them through two meta-tools:

- **`search_tools`** — Search for tools by name, description, or provider. Results are auto-enabled for use.
- **`run_tool`** — Execute any discovered tool by its namespaced name (e.g. `linear__create_issue`).

The AI assistant calls `search_tools` automatically when it detects a relevant intent, then uses `run_tool` or calls the auto-enabled tools directly.

## Configuration

### STDIO servers

Servers that run as local subprocesses:

```json
{
  "mcpUpstreams": {
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
  "mcpUpstreams": {
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
