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

Your MCP client only sees `search_tools` and `run_tool`, so permission rules it keeps per tool can't tell upstream tools apart. Allowing `run_tool` in your client permits every upstream tool these policies allow, so set `"prompt"` or `"never"` on the tools that need a guard.

## Rate limiting

The bridge applies a preemptive rate limit to every upstream so an LLM's bursty tool calls don't blow through the upstream's API quota. When the limit is hit, calls wait in a FIFO queue until the sliding window opens — the LLM just sees slightly higher latency instead of an error. Each queued call has its own 60-second timeout; past that it fails.

### Defaults

Out of the box, every upstream gets `{ maxCalls: 30, windowSeconds: 6 }` — averaging 5 calls per second, smoothed across a 6-second window. This protects upstreams the user didn't think to configure; the first time the default actually blocks a call on a given upstream, the bridge logs an INFO message naming both opt-out paths.

### Per-server override

```json
{
  "upstreamMcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic/github-mcp-server"],
      "_bridge": {
        "rateLimit": { "maxCalls": 30, "windowSeconds": 60 }
      }
    }
  }
}
```

The `github` server is capped at 30 calls per 60-second window. Per-server values override both the global default and the hardcoded fallback.

### Global default

```json
{
  "_bridge": {
    "defaultRateLimit": { "maxCalls": 60, "windowSeconds": 10 }
  }
}
```

Every upstream that doesn't set its own `_bridge.rateLimit` follows this. Replaces the hardcoded `30/6` fallback.

### Opting out

Set the value to `false` to disable rate limiting:

```json
{
  "upstreamMcpServers": {
    "fast-local": {
      "command": "...",
      "_bridge": { "rateLimit": false }
    }
  },
  "_bridge": {
    "defaultRateLimit": false
  }
}
```

- Per-server `false` opts that upstream out (regardless of the global default).
- Global `defaultRateLimit: false` opts out every upstream that didn't set its own.

### Resolution order

First match wins:

1. Per-server `_bridge.rateLimit === false` → no limit
2. Per-server `_bridge.rateLimit` object → use it
3. Global `_bridge.defaultRateLimit === false` → no limit
4. Global `_bridge.defaultRateLimit` object → use it
5. Otherwise → hardcoded `{ maxCalls: 30, windowSeconds: 6 }`

Rate limit configuration is hot-reloadable. When a hot-reload lifts a limit (per-server or global flips to `false`) while calls are queued, those queued calls fire immediately instead of erroring — the user's intent was to remove the throttle.
