# Authentication

The bridge supports two authentication styles for upstream servers:

- **Static credentials** — bearer tokens, API keys, or anything else you embed in `env` or `headers`. Store the value once in the encrypted credential store and reference it from config.
- **OAuth 2.1** — for HTTP upstreams that advertise OAuth (Linear, Notion, etc.). Run a one-time browser flow with `crabeye-mcp-bridge auth <server>`; crabeye handles refresh automatically thereafter.

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

A browser tab opens, you authorize, and the resulting tokens are stored in the encrypted credential store. From then on, the [manager](stdio-manager.md#http-and-sse-upstreams) uses them and refreshes them when the upstream returns 401, once for every client. No config change is required — stored OAuth tokens are found by server name and an OAuth client is attached transparently.

**When authorization expires.** If the authorization server rejects the stored tokens, or the upstream keeps refusing the credentials, the [manager](stdio-manager.md#http-and-sse-upstreams) pauses that upstream for every client at once instead of retrying in the background. Its tools stay searchable, and a `run_tool` call tries the connection once more before returning an error that tells you to run `crabeye-mcp-bridge auth <server>` (or, for an upstream that doesn't use OAuth, to update its configured credentials). As soon as `crabeye-mcp-bridge auth <server>` finishes, a running manager connects that server again for every client, so the next call works without restarting any client. When the manager isn't told, for example after authorizing with crabeye 1.3.0 or earlier, the next call or config reload connects it again. If the authorization server is only unreachable, the manager keeps retrying in the background as for any other outage.

**Removing credentials.** `crabeye-mcp-bridge auth --remove <server>` takes effect at once as well: a running manager connects that server again without the removed credentials, so an upstream that needs them is paused for every client. A refresh the manager still has under way when it is told doesn't undo `auth` or `auth --remove`. One that finishes in the instant before, while the credentials are being removed, can still put them back: if `crabeye-mcp-bridge daemon status` shows the server connected afterwards, run `auth --remove` again. Neither `auth` nor `auth --remove` starts the manager, and their output is the same whether or not one is running; with one running, they can take a few seconds longer to return while it connects the server again, and a call to that server running at that moment fails.

**Several clients sharing an upstream.** The manager refreshes an upstream's stored tokens once for every client. That holds even for clients whose config or network settings give them separate connections to the same server: refreshes of the same tokens at the same authorization server are sent once, so clients never refresh them against each other.

Tokens are still refreshed independently of the manager by bridges and CLIs from crabeye 1.3.0 or earlier, and by `crabeye-mcp-bridge auth` when it finds tokens it can refresh. When one of these refreshes at the same moment as the manager and the authorization server rotates refresh tokens, one gets new tokens, and the other's refresh is rejected because its refresh token was just replaced. The one whose refresh was rejected keeps the tokens the other one saved and uses them, so no client has to re-authorize; a bridge or CLI from crabeye 1.3.0 or earlier deletes the tokens instead. A call made at that moment can still fail with the usual advice to run `crabeye-mcp-bridge auth <server>`; a call made a moment later works without it. Running `crabeye-mcp-bridge auth <server>` at that moment usually reports the upstream as already authenticated; if it opens a browser instead, the manager's new tokens are kept, and you can cancel or finish authorizing as usual. An authorization server that revokes every token issued to a client as soon as one is reused still signs out every client.

### `auth` subcommands

| Command | Description |
|---------|-------------|
| `auth <server>` | Run the OAuth flow for a server. Opens a browser and listens on a loopback redirect URL. A running manager then connects the server again for every client. |
| `auth --list` (or bare `auth`) | Show per-server auth status: `authenticated`, `auth-required`, or `advertises-oauth` for non-configured HTTP upstreams that surface OAuth via discovery. |
| `auth --remove <server>` | Delete local OAuth tokens, client secret, stored dynamic-client registration, and the authorization-server binding for a server. Does not call any provider revocation endpoint. A running manager then connects the server again without them. |
| `auth help` (or `--help` / `-h`) | Full usage. |

**Authorization-server binding.** When a server's `_bridge.auth.clientId` comes from config, crabeye remembers which authorization server it first contacted. If a later discovery points somewhere else, `auth` and the runtime refuse to send your client credentials there and report that the authorization server is no longer the one it was bound to. If you did not expect the change, treat it as a possible authorization-server mix-up and check the upstream before doing anything else. If the move is legitimate, run `auth --remove <server>` and authenticate again — or, if you are also switching to a new client, update `clientId` in config; a changed `clientId` rebinds automatically.

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
2. `${ENV_VAR}` reference in config, e.g. `"clientSecret": "${NOTION_OAUTH_SECRET}"`. The variable name must contain `OAUTH` as a bounded segment (`NOTION_OAUTH_SECRET`, `XOAUTH2_BEARER`, etc.) so a tampered config can't exfiltrate unrelated env vars as the client secret. The manager reads the variable from the environment the AI client starts the bridge with (its MCP entry), and `crabeye-mcp-bridge auth` reads it from your shell's. Clients that set different values get separate connections.
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

Several AI clients, bridges and CLI commands can save credentials at the same time without losing each other's changes, and an interrupted save leaves the previously saved credentials readable. A bridge or CLI from crabeye 1.3.0 or earlier doesn't take part in this, so while one is still running, its saves can still overwrite another process's.

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
