# Crabeye MCP Bridge

One MCP connection for all your tools — with discovery, namespacing, and execution policies.

Every MCP server you add to your AI assistant means another connection, another set of tool definitions injected into the context window, and no way to search or control them centrally. Wire up ten servers with a hundred tools each and your assistant is burning tokens on a thousand tool schemas before the conversation even starts — most of which it will never call.

crabeye-mcp-bridge consolidates all your upstream MCP servers behind a single STDIO interface and exposes exactly **two tools** to the assistant: `search_tools` and `run_tool`. Tools from every server are discovered, namespaced, and indexed at startup, but none of them touch the context window until the assistant actually searches for them. You can have a thousand tools ready to go without bloating the context, with fuzzy search to find them and per-tool execution policies to control what runs freely, what needs approval, and what is blocked.

![crabeye-mcp-bridge topology: one STDIO connection from an AI assistant to the bridge exposes two tools — search_tools and run_tool — while the bridge fans out to upstream MCP servers like Linear, GitHub, Slack, Sentry, and Figma. Tool schemas stay out of the context window until a search hits.](docs/img/hero.png)

## Quick start

The fastest way to get started is with `init`, which discovers your MCP client configs and sets up the bridge automatically:

```bash
npx @crabeye-ai/crabeye-mcp-bridge init
```

This scans for config files from Claude Desktop, Cursor, VS Code Copilot, Windsurf, and Zed, lets you pick which ones to use, and optionally injects the bridge entry. After that, just run `npx @crabeye-ai/crabeye-mcp-bridge` — no `--config` flag needed.

To undo, run `npx @crabeye-ai/crabeye-mcp-bridge restore`.

### Manual setup

If you prefer to set things up manually, say your MCP client config looks like this today:

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

First, store your secrets in the encrypted credential store:

```bash
crabeye-mcp-bridge credential set github-pat ghp_abc123
```

Then rename `mcpServers` to `upstreamMcpServers`, add the bridge, and replace hardcoded tokens with `${credential:key}` references:

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
        "GITHUB_TOKEN": "${credential:github-pat}"
      }
    }
  }
}
```

That's it. Your AI assistant now has access to all tools from all configured servers through a single connection. The bridge automatically excludes itself from `mcpServers` to avoid recursion, so pointing `--config` at the same file is safe.

The bridge also reads `upstreamServers` (shorthand), `servers` (VS Code Copilot), and `context_servers` (Zed) as input keys. See [docs/configuration.md](docs/configuration.md) for the full priority order and self-exclusion rules.

Alternatively, you can add the bridge alongside your existing `mcpServers` entries without renaming anything — the bridge will pick up the other servers from `mcpServers` automatically (excluding itself). Disable the other MCP servers in your client so the assistant uses the bridge as the single entry point.

## Features

- **Discovery + search.** Two meta-tools (`search_tools`, `run_tool`) instead of N×M tool definitions in context. See [docs/how-it-works.md](docs/how-it-works.md).
- **Configuration.** STDIO, HTTP, and SSE upstreams; categories; multi-source config keys. See [docs/configuration.md](docs/configuration.md).
- **Authentication.** Encrypted credential store, OS-keychain-backed master key, `${credential:key}` templates. See [docs/auth.md](docs/auth.md).
- **Policies.** Per-tool / per-server / global tool policies (`always` / `prompt` / `never`), rate limiting, discovery modes. See [docs/policies.md](docs/policies.md).
- **STDIO manager.** STDIO upstreams routed through a per-user manager process so multiple bridges share a single subprocess per upstream. See [docs/stdio-manager.md](docs/stdio-manager.md).
- **CLI.** `init`, `restore`, `credential`, `daemon`, `--validate`. See [docs/cli.md](docs/cli.md).

## License

MIT
