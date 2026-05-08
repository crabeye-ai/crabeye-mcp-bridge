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

Self-exclusion applies to `mcpServers` and `context_servers` — the bridge will skip its own entry to avoid recursion.
