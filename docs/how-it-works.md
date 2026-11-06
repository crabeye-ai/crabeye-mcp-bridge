# How it works

When the AI assistant starts its session, every configured upstream server is started or connected and the bridge discovers its tools. An assistant that only checks which protocol version the bridge speaks, then disconnects, starts none of them. A per-user [manager](stdio-manager.md) process shared by every bridge starts every STDIO server and connects every upstream, once for all bridges. A bridge starts the manager as soon as its config has an upstream, or else when its client starts a session. Each bridge does little itself: it checks its config when it starts and reports a config that doesn't load, then leaves the servers, search, rate limits, tool policy and config edits to the manager. What it keeps is what concerns its own client: answering it, asking it to approve calls the tool policy marks `prompt`, cancelling calls it cancels, and `--stats`. Each tool is namespaced by server name (e.g. `linear__create_issue`, `github__list_repos`) so tools from different servers never collide.

The bridge exposes exactly two tools to the AI assistant, and they stay the same two for the whole session:

- **`search_tools`** — Fuzzy-search across all discovered tools by name, description, provider, or category.
- **`run_tool`** — Run any discovered tool by its namespaced name (e.g. `linear__create_issue`).

The AI assistant calls `search_tools` when it detects a relevant intent, then runs the tool it found with `run_tool`. When a search returns tools, each comes with its full input schema. Upstream tools can only be run through `run_tool`: calling one by its own name fails as an unknown tool.

### Servers and their status

The end of the `search_tools` description lists every server in the config, with its category, so the assistant knows what it can search for. A server that isn't connected is listed with its status:

```
Servers (search by provider name):
- linear [issues]
- github: starting
- notion: needs authorization; the user runs: crabeye-mcp-bridge auth notion, or updates its credentials if it doesn't use OAuth
- jira: not connected
```

A server whose connection dropped is listed as starting while it reconnects. One that failed to connect stays listed as not connected while it tries again, so a server that keeps failing doesn't change the list each time.

Before the bridge has heard from the [manager](stdio-manager.md), it lists the servers in its own config; afterwards, when it can't reach the manager, the servers the manager last reported. Either way it leaves out their categories, and lists them as not connected while the manager can't be reached, or as starting while the manager starts or is being replaced.

The server names and categories are part of what the assistant sees on every request, as tool descriptions are.

Whenever the list changes (a server starts, connects, stops, needs authorization or gets it, or a config edit adds or removes a server or changes a category), the bridge tells the assistant its tool list changed, and the assistant reads the description again. Changes that come close together are announced once, at most once a second. A change that is undone within that second isn't announced.

A server's tools are searched while it is connected, and while it reconnects after its connection dropped. Once an attempt to connect fails, or it needs authorization, its tools leave the search until it connects again. A search whose `provider` matches a server that isn't connected returns that server with a `status` (`starting`, `not_connected` or `needs_authorization`) and a `message` saying why: try again shortly (or, for a server reconnecting with its tools, that a call waits for it), the reason it couldn't connect, or the `crabeye-mcp-bridge auth <server>` command to run. Anything in the reason that looks like a credential, such as a bearer token or a `password=` value, is replaced with `[redacted]`. A query with a `category` gets only the servers in that category, and a query for a later page (an `offset` above 0) gets none.

```json
{ "name": "jira", "tool_count": 0, "tools": [], "status": "not_connected", "message": "\"jira\" is not connected: connect ECONNREFUSED 127.0.0.1:8080" }
```

The bridge tracks how many tokens it saves compared to exposing all upstream tool definitions directly. Token savings are always logged to stderr after each search. To also include them in `search_tools` responses, pass `--stats`:

```json
{
  "session_stats": {
    "tokens_saved": 11200,
    "baseline_tokens": 14200,
    "bridge_tokens": 3000
  },
  "results": [...]
}
```

- **`baseline_tokens`** — estimated tokens if all upstream tool definitions were injected into context without the bridge
- **`bridge_tokens`** — cumulative tokens used by the bridge's two meta-tools plus all search results returned so far
- **`tokens_saved`** — the difference (baseline − bridge)

Token counts are estimated using a chars/4 heuristic.

## Bridge instructions

The bridge gives every client the same fixed instructions when it connects: when and how to call `search_tools` and `run_tool`. They don't depend on which servers are configured or connected.

A server's own instructions come with search results instead, for servers that opt in with `_bridge.passthrough` (see [configuration.md](configuration.md#context-passthrough)). The assistant asks for them only when it needs them, so it spends no tokens on the instructions of servers it never uses.

## Examples

### Discovering providers

The assistant starts by searching for providers to see what's available. Without a `tool` filter, provider summaries are returned — name, category, and tool count, but no tool details:

```json
{
  "name": "search_tools",
  "arguments": {
    "queries": [{ "provider": "linear" }]
  }
}
```

Response:

```json
{
  "results": [
    {
      "providers": [
        {
          "name": "linear",
          "category": "project management",
          "tool_count": 47,
          "tools": []
        }
      ],
      "total": 47,
      "count": 0,
      "offset": 0,
      "limit": 10
    }
  ]
}
```

To get full tool definitions, add `expand_tools: true` or use a `tool` filter to drill in:

```json
{
  "name": "search_tools",
  "arguments": {
    "queries": [{ "provider": "linear", "expand_tools": true }]
  }
}
```

When a server has [`_bridge.passthrough`](configuration.md#context-passthrough) on and has sent instructions, its entry in the results is marked `"has_instructions": true`. To get them, add `include_instructions: true` to the query:

```json
{
  "name": "search_tools",
  "arguments": {
    "queries": [{ "provider": "linear", "include_instructions": true }]
  }
}
```

The server's result then carries its instructions in an `instructions` field. A server matched by several queries in one search gets them once, under the first query that asks for them.

### Searching for tools

The assistant calls `search_tools` with a `tool` filter to find specific tools by name or description. Results are grouped by provider:

```json
{
  "name": "search_tools",
  "arguments": {
    "queries": [{ "tool": "create issue" }]
  }
}
```

The bridge returns matching tools with their full input schemas, grouped by provider:

```json
{
  "results": [
    {
      "providers": [
        {
          "name": "linear",
          "category": "project management",
          "tool_count": 47,
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
            }
          ]
        },
        {
          "name": "github",
          "tool_count": 32,
          "tools": [
            {
              "tool_name": "github__create_issue",
              "source": "github",
              "description": "Create a GitHub issue",
              "input_schema": { "..." }
            }
          ]
        }
      ],
      "total": 2,
      "count": 2,
      "offset": 0,
      "limit": 10
    }
  ]
}
```

The assistant runs any of these tools with `run_tool`, passing its `tool_name` as `name`.

### Multiple queries

Pass multiple query objects to search for different things in a single call. Results are deduplicated across queries — first query wins. Summary and detail queries can be mixed:

```json
{
  "name": "search_tools",
  "arguments": {
    "queries": [
      { "tool": "create issue" },
      { "provider": "github" },
      { "category": "design", "expand_tools": true }
    ]
  }
}
```

The first query returns tool details (has `tool` filter), the second returns a provider summary, and the third returns expanded tool details for design tools. Each query produces its own result set with independent pagination.

A search takes at most 64 queries, and a `tool`, `provider` or `category` term of at most 1 KiB. Only the first 16,384 characters of a tool's description are searched, though results show all of it, and a word is matched by its first 64 characters. A tool whose name on its server is longer than 1,024 bytes isn't found, as it can't be called. A search that runs longer than 2 seconds stops with an error asking for simpler regexes or fewer queries.

### Running a tool without searching

If the assistant already knows the namespaced name, it can skip the search and call `run_tool` right away:

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

Combine a tool search with a provider filter to narrow results:

```json
{
  "name": "search_tools",
  "arguments": {
    "queries": [{ "tool": "list", "provider": "github" }]
  }
}
```

Only tools from the `github` server matching "list" are returned, grouped under the `github` provider. Provider matching uses prefix match by default (`"git"` matches `"github"`, but `"hub"` does not).

### Regex search

For precise matching, prefix the tool query with `regex:`:

```json
{
  "name": "search_tools",
  "arguments": {
    "queries": [{ "tool": "regex:^list_" }]
  }
}
```

This finds all tools whose name starts with `list_` — across every server.

A regex is matched in time that grows only with the pattern and the text it is matched against, so one search can't hold up the [manager](stdio-manager.md) for every client. A pattern that can't be matched that way is searched as plain text instead: one with a backreference, a lookahead, a Unicode property escape such as `\p{L}`, an inline flag such as `(?i:…)`, or a counted repeat above 16 such as `{17}`, and one with the `u` or `v` flag. `/pattern/i` ignores case, but an escaped letter written in octal, or a class range such as `[A-z]`, isn't matched in both cases, and a range such as `[Z-a]`, which runs backwards once lower-cased, makes the pattern plain text. Patterns longer than 200 characters are searched as plain text too. See [Multiple queries](#multiple-queries) for the limits on a search.
