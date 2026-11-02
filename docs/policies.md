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

Your MCP client only sees `search_tools` and `run_tool`, so permission rules it keeps per tool can't tell upstream tools apart. Allowing `run_tool` in your client permits every upstream tool these policies allow, so set `"prompt"` or `"never"` on the tools that need a guard. `"prompt"` makes the assistant ask you before each call; it doesn't stop other programs running as your user, which can reach the manager directly. `"never"` blocks a tool for everyone.

## Rate limiting

A preemptive rate limit applies to every upstream so an LLM's bursty tool calls don't blow through the upstream's API quota. When the limit is hit, calls wait in a FIFO queue until the sliding window opens — the LLM just sees slightly higher latency instead of an error. Each queued call has its own 60-second timeout; past that it fails. A call cancelled while it waits gives up its place.

The [manager](stdio-manager.md) enforces the limit once for every AI client: with three clients open on the same config, a server limited to 30 calls per window gets at most 30 calls per window from all of them together, not 30 from each. One budget covers every call that goes through the same connection to the server under the same limit, so it also covers clients that load different configs, when those configs connect to the server the same way (see [How sharing works](stdio-manager.md#how-sharing-works) and [Configs and connections](stdio-manager.md#configs-and-connections)). Configs that give a shared server different limits each have their own budget, so the server can get up to the sum; configs that connect to it differently have their own connection and their own budget. Because clients share the queue too, one client's burst can make another client's call wait, or fail once the queue is full.

### Defaults

Out of the box, every upstream gets `{ maxCalls: 30, windowSeconds: 6 }` — averaging 5 calls per second, smoothed across a 6-second window. This protects upstreams the user didn't think to configure; the first time the default actually blocks a call on a given upstream, the manager logs an INFO message naming both opt-out paths, and it shows in the log of every client whose config follows that default for the upstream.

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

Rate limit configuration is hot-reloadable, for every client at once and without restarting the server. A call waiting for its turn follows the config's server:

- when a reload lifts the limit (per-server or global flips to `false`), the call runs at once instead of erroring — the user's intent was to remove the throttle;
- when a reload changes the limit, the call waits under the new one; the calls made within the window still count, unless another config already uses the new limit on that connection, in which case its budget applies as it stands;
- when a reload changes how the server is started or connected, the call waits for a turn on the new connection;
- when a reload removes the server, the call fails at once.

A call that waits again this way starts its 60-second timeout again.

A call that waited for its turn is checked against the tool policy again before it runs, so a reload that disables its tool meanwhile stops it.
