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

`type` defaults to `"streamable-http"`. Use `"sse"` for servers that use Server-Sent Events transport.

HTTP/SSE upstreams are **not** routed through the manager; each bridge connects directly.

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

## Config sources

The bridge reads upstream definitions from these top-level keys (in priority order, first wins on duplicate names):

1. `upstreamMcpServers`
2. `upstreamServers` (shorthand)
3. `servers` (VS Code Copilot)
4. `context_servers` (Zed)
5. `mcpServers`

Self-exclusion applies to `mcpServers` and `context_servers` — the bridge will skip its own entry to avoid recursion.
