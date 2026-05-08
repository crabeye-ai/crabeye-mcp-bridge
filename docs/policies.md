# Policies and limits

## Tool policies

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

## Rate limiting

Prevent the bridge from exceeding upstream API quotas by setting per-server rate limits. When the limit is hit, calls wait in a FIFO queue until the sliding window opens — the LLM just sees slightly higher latency instead of an error.

```json
{
  "upstreamMcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic/github-mcp-server"],
      "_bridge": {
        "rateLimit": {
          "maxCalls": 30,
          "windowSeconds": 60
        }
      }
    }
  }
}
```

In this example, the bridge allows at most 30 tool calls to the `github` server per 60-second sliding window. If a 31st call arrives before the window slides, it waits until a slot opens. If the wait exceeds 30 seconds, the call fails with an error.

Rate limit configuration is hot-reloadable — changes take effect without restarting the bridge.

## Discovery mode

Control how searched tools are surfaced to the assistant with `--discovery-mode`:

- **`both`** (default) — Search results include tool names, descriptions, and full input schemas. Matching tools are also added to the MCP tools list so the assistant can call them directly.
- **`search`** — Search results include full tool details, but tools are NOT added to the MCP tools list. The assistant must use `run_tool` to execute them. Use this when your client doesn't handle dynamic tool list changes well.
- **`tools_list`** — Matching tools are added to the MCP tools list with full schemas, but search results omit `input_schema` to avoid duplication. The assistant calls discovered tools directly by their namespaced name, or via `run_tool`.

```bash
npx @crabeye-ai/crabeye-mcp-bridge --config config.json --discovery-mode search
```
