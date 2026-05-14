# Authentication

The bridge supports two authentication styles for upstream servers:

- **Static credentials** — bearer tokens, API keys, or anything else you embed in `env` or `headers`. Store the value once in the encrypted credential store and reference it from config.
- **OAuth 2.1** — for HTTP upstreams that advertise OAuth (Linear, Notion, etc.). Run a one-time browser flow with `crabeye-mcp-bridge auth <server>`; the bridge handles refresh automatically thereafter.

## Static credentials

Store a secret once, then reference it with `${credential:key}` in `env` or `headers`:

```bash
# Store credentials
crabeye-mcp-bridge credential set github-pat ghp_abc123
crabeye-mcp-bridge credential set remote-api-key sk_live_xyz
```

```json
{
  "upstreamMcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@anthropic/github-mcp-server"],
      "env": { "GITHUB_TOKEN": "${credential:github-pat}" }
    },
    "remote-api": {
      "url": "https://mcp.example.com/sse",
      "type": "sse",
      "headers": { "Authorization": "Bearer ${credential:remote-api-key}" }
    }
  }
}
```

Templates are resolved on every connect and reconnect, so rotating a credential takes effect without restarting the bridge.

## OAuth

For an HTTP upstream that advertises OAuth, run a single command:

```bash
crabeye-mcp-bridge auth Linear
```

A browser tab opens, you authorize, and the bridge stores the resulting tokens in the encrypted credential store. From that point on, the bridge uses those tokens automatically and refreshes them when the upstream returns 401. No config change is required — the bridge detects stored OAuth tokens by server name and attaches an OAuth client transparently.

### `auth` subcommands

| Command | Description |
|---------|-------------|
| `auth <server>` | Run the OAuth flow for a server. Opens a browser and listens on a loopback redirect URL. |
| `auth --list` (or bare `auth`) | Show per-server auth status: `authenticated`, `auth-required`, or `advertises-oauth` for non-configured HTTP upstreams that surface OAuth via discovery. |
| `auth --remove <server>` | Delete local OAuth tokens, client secret, and stored dynamic-client registration for a server. Does not call any provider revocation endpoint. |
| `auth help` (or `--help` / `-h`) | Full usage. |

The flow:

1. Generates a PKCE verifier + S256 challenge and a random `state`.
2. Starts a one-shot HTTP listener on `127.0.0.1` at either a random free port or `_bridge.auth.redirectPort` if you've pinned one.
3. Prints the authorization URL to stderr and tries to open it in your default browser. If the launcher fails (headless terminal, missing `xdg-open`, etc.), copy the printed URL into any browser on a machine that can reach the upstream — the redirect must come back to your loopback, so this usually means the same machine.
4. Verifies the returned `state`, exchanges the code at the token endpoint, and writes `oauth:<server>` to the credential store.
5. Five-minute timeout. Ctrl-C aborts cleanly.

### Explicit OAuth config

You can run `auth <server>` against any HTTP upstream — the bridge does RFC 9728 / RFC 8414 discovery and RFC 7591 dynamic client registration. You only need an explicit `_bridge.auth` block to override what discovery returns or pin a pre-registered client:

```json
{
  "upstreamMcpServers": {
    "notion": {
      "url": "https://mcp.notion.com/mcp",
      "_bridge": {
        "auth": {
          "type": "oauth2",
          "clientId": "pre-registered-client-id",
          "scopes": ["read", "write"],
          "redirectPort": 18234,
          "clientSecret": "${NOTION_OAUTH_SECRET}"
        }
      }
    }
  }
}
```

All fields under `_bridge.auth` other than `type` are optional. `redirectPort` pins the loopback port (range 1024–65535); useful when the provider only allows pre-registered redirect URIs. `scopes` are passed on the authorization request. `endpoints` lets you override discovered authorization/token URLs entirely (both must be `http(s)` and same-origin).

### Confidential clients

If your provider issues a `client_secret`, supply it in this order (first hit wins):

1. Credential store entry under `oauth-client-secret:<server>` (recommended; encrypted at rest):
   ```bash
   crabeye-mcp-bridge credential set oauth-client-secret:notion shh_xyz
   ```
2. `${ENV_VAR}` reference in config, e.g. `"clientSecret": "${NOTION_OAUTH_SECRET}"`. The variable name must contain `OAUTH` as a bounded segment (`NOTION_OAUTH_SECRET`, `XOAUTH2_BEARER`, etc.) so a tampered config can't exfiltrate unrelated env vars as the client secret.
3. Inline plain string in config. Works but discouraged — config files are often shared or committed.

Public clients (PKCE-only) just omit `clientSecret` entirely.

### Platform notes

- **macOS / Linux** with a desktop session: the browser opens automatically.
- **Windows**: launched via `powershell Start-Process`. PowerShell ships with all supported versions.
- **Headless / SSH-only**: `auth` still prints the authorization URL; copy it into a browser on any machine that can hit the same loopback. The redirect comes back to `127.0.0.1`, so for fully-remote scenarios you'll want a device-code flow — see open issue for RFC 8628 support.
- **Linux without a keyring daemon**: the bridge's master key needs either `gnome-keyring` / KDE Wallet running, or `MCP_BRIDGE_MASTER_KEY` set to a 64-char hex string.

### Migrating away from a static bearer

If you previously authenticated by stuffing a static `Authorization: Bearer ...` into the upstream's `headers`, switch to OAuth by:

1. Run `crabeye-mcp-bridge auth <server>` once.
2. Remove the static `Authorization` header from your config (or leave it — the bridge will strip it and warn when OAuth is in play, so it can't silently override the managed token).

## How it works

Credentials are encrypted with AES-256-GCM. The master key is stored in your OS keychain (macOS Keychain, Linux secret-tool, Windows Credential Manager). Set `MCP_BRIDGE_MASTER_KEY` (64 hex chars) to use a static key instead.

## CLI commands

| Command | Description |
|---------|-------------|
| `credential set <key> [value]` | Store a plain string secret |
| `credential set <key> --json '<json>'` | Store a typed credential (bearer/oauth2/secret) |
| `credential get <key>` | Retrieve a credential (masked by default, `--show-secret` for full) |
| `credential delete <key>` | Delete a stored credential |
| `credential list` | List all stored credential keys |
| `auth <server>` | Run OAuth flow for an upstream |
| `auth --list` | Show OAuth status per server |
| `auth --remove <server>` | Delete stored OAuth credentials for a server |

Pipe-friendly: `echo "ghp_abc123" | crabeye-mcp-bridge credential set github-pat`
