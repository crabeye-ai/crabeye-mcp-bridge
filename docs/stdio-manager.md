# STDIO manager

The STDIO manager is a per-user background process the bridge spawns automatically. It owns every STDIO upstream MCP server and lets multiple bridges share one subprocess per upstream — so running Claude Desktop, Cursor, and a CLI bridge against the same Linear MCP server doesn't spawn three copies of the Linear MCP server.

The manager also connects every HTTP and SSE upstream, once for every bridge that uses them (see [HTTP and SSE upstreams](#http-and-sse-upstreams)). There is no inline fallback for either kind: when the manager can't be started or reached, those upstreams fail to connect and say why, and the bridge keeps trying.

## Why it exists

Without the manager, every running bridge spawns its own copy of every configured STDIO upstream MCP server. Run **N bridges** (one per editor / agent) against **M servers** and you get **N × M subprocesses**. Each one consumes its own RAM, file handles, and re-runs the upstream's auth handshake.

The manager collapses this: it starts each STDIO server once and connects to it itself, and every bridge calls the server's tools through the manager. Identical server entries across bridges share a single child.

![Per-bridge topology: each bridge spawns its own copy of every STDIO upstream server, leading to N × M subprocesses across the system.](img/topology-per-bridge.png)

![Manager-shared topology: every bridge connects to a single per-user manager process over UDS / named pipe; the manager owns one shared subprocess per unique upstream spec across all bridges.](img/topology-daemon-shared.png)

## How sharing works

Bridges that load the same config share the manager's copy of it (see [Configs and connections](#configs-and-connections)), and every bridge using that config calls a STDIO server's tools through the manager's one connection to it.

A child is shared across configs too. Two entries share a child if they have the same command, arguments, `env` (as written, before `${credential:…}` is filled in), working directory (`cwd`) and reconnect settings, and, when their `env` reads stored credentials, the same master key. The server's name in your config doesn't count.

`_bridge.sharing` and the `_bridge.daemon` auto-fork settings no longer exist; the bridge ignores them and logs a warning when a config still sets them.

A shared child serves all of its bridges at once. A server that keeps state in memory, such as a browser it opened, shares that state with every assistant using it. To keep two copies of a server apart, give them different `env` or `args`.

### A STDIO server's environment

A STDIO server starts with the environment of the AI client whose bridge first loaded the config (the variables its MCP entry and its own environment give the bridge), with the server's `env` on top. A client that starts using the config later doesn't change it, and a server shared with another config keeps the environment it started with, also when it is restarted. After changing the environment an AI client gives its bridge, restart that AI client, then run `crabeye-mcp-bridge daemon restart` for STDIO servers to get it. With several AI clients open, servers get the environment of whichever client's bridge reconnects first, so restart or close the others too, for example when removing a secret. On Windows, variable names that differ only in case, such as `Path` and `PATH`, are one variable, and the server's `env` wins.

A server never gets `MCP_BRIDGE_MASTER_KEY`, whether the client's MCP entry sets it or the server's `env` does. It also never gets the variables that make a runtime load other code: `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `LD_DEBUG`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `DYLD_FRAMEWORK_PATH`, `DYLD_FALLBACK_LIBRARY_PATH`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_PRESERVE_SYMLINKS`, `PYTHONPATH`, `PYTHONSTARTUP` and `PYTHONHOME`.

The manager fills in `${credential:…}` values in `env` itself, each time it starts the server, so a changed credential is used from the next start on. When a credential is missing, the server shows the error and the manager keeps trying, so storing the credential is enough.

A `cwd` must be an absolute path; a server with a relative one fails to start, saying so. So does a server whose command, arguments or `env` (after `${…}` values are filled in) hold a character a process can't be started with, such as a NUL, or whose `env` has a variable name with `=` in it. The error names the variable or argument, never its value.

## Configs and connections

Bridges that load the same config share the manager's copy of it: the same `--config` file (or `MCP_BRIDGE_CONFIG`), or, without either, the default set made of `~/.crabeye-mcp-bridge/config.json` and the client config files it lists. A bridge whose MCP entry sets different values for any of these variables gets its own copy, so its HTTP and SSE connections and stored credentials are never another client's (a STDIO server can still be shared; see [A STDIO server's environment](#a-stdio-servers-environment)):

* `MCP_BRIDGE_MASTER_KEY`;
* the variables a `clientSecret` can name (see [the naming rule](auth.md#confidential-clients));
* the network settings below.

The manager reads the config files and the credential store itself, follows edits to the files it loaded (the `--config` file, or the client config files), applying a change once for every bridge, and reads the config again whenever another bridge starts using it.

A config's connections and STDIO servers stay in use while a bridge uses that config, and for `_bridge.daemon.idleMs` after the last such bridge disconnects; a bridge that starts in between reuses them instead of connecting again. A STDIO server then keeps running for `_bridge.daemon.graceMs`, in case a config that uses it opens again.

If the manager is stopped or replaced while a call is running, that call fails with `daemon shutdown`, or with `daemon connection closed` when the manager crashes or is killed. The bridge starts a new manager, which starts and connects every server again, and later calls go through without restarting the client. A tool result too large for the manager to pass on (over 16 MB) fails with an error saying so.

What `search_tools` and `run_tool` show doesn't change: each bridge still applies its own tool policy, rate limits and passthrough settings. Cancelling a call cancels it at the server, and each server's instructions reach every client.

## HTTP and SSE upstreams

The manager connects every HTTP and SSE upstream, including servers you authorized with `crabeye-mcp-bridge auth <server>` and no config change.

The manager connects each client's HTTP and SSE upstreams with that client's network settings, not with its own:

* it checks certificates unless the client sets `NODE_TLS_REJECT_UNAUTHORIZED=0`;
* it trusts Node's own certificates, the certificates in the client's `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`, and the system's certificates when the client sets `NODE_USE_SYSTEM_CA=1` or runs Node with `--use-system-ca`;
* it goes through the client's `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (upper or lower case) when the client sets `NODE_USE_ENV_PROXY=1` or runs Node with `--use-env-proxy`.

A setting that makes no difference, such as a proxy variable without `NODE_USE_ENV_PROXY=1`, doesn't give a client its own copy. The manager reads a client's certificate files when it opens that client's connection; after you change one, run `crabeye-mcp-bridge daemon restart`.

The manager runs without `NODE_OPTIONS`. A bridge whose Node options would change its connections in other ways, such as `--use-openssl-ca`, `--tls-min-v1.3` or `--require` for a proxy agent, logs a warning naming them, since the manager doesn't apply them.

The manager's own `OPENSSL_CONF`, from the client whose bridge started it, applies to every client. Its `SSL_CERT_DIR`, on Node builds that read it, applies only to clients whose certificate settings are the same as its own and that set no `SSL_CERT_FILE`. On Linux, the system's certificates are read with the manager's own `SSL_CERT_FILE` and `SSL_CERT_DIR`.

Each upstream gets one connection for all of these bridges. Two entries share a connection, even across configs, if they have the same server name, transport, URL, headers (as written, before `${credential:…}` is filled in), `_bridge.auth` settings, master key, value of the variable their `clientSecret` names, and network settings. A server on the 2026-07-28 protocol sees one client, and a server on an earlier protocol sees one session. When a server ends that session, the manager starts one new session for everyone once the connection closes or three health checks in a row fail.

The manager:

* fills in `${credential:…}` header values on every connect, so a changed credential is used from the next connect on;
* checks each connection's health once, with the `healthCheckInterval` of the longest-standing config using it and the reconnect settings of the config that first needed it;
* uses and refreshes stored OAuth tokens for every bridge at once, so clients don't each refresh an expired token, even when their settings give them separate connections to the server, and pauses an upstream that needs authorization for every bridge at once;
* reads a `clientSecret` from the variables of the client the connection is for, never from its own environment;
* connects a server again for every bridge as soon as `crabeye-mcp-bridge auth <server>` or `auth --remove <server>` changes its stored credentials.

When an HTTP or SSE server's URL, headers or `_bridge.auth` change in `~/.crabeye-mcp-bridge/config.json`, its connection follows the edit for every client once any client restarts. If the edit removes the server, clients that haven't restarted can't use it until they restart. A changed `healthCheckInterval` also applies to these connections once any client restarts, while changed reconnect settings apply only to connections opened after the edit. Everything else in that file takes effect for each client when that client restarts. The same goes for a STDIO server's settings and the global `_bridge.reconnect` in that file: the manager follows edits to the client config files it lists and to a `--config` file, but reads `config.json` itself again only when a client starts.

The [manager log](#manager-log) records what happens to these upstreams. Their warnings and errors also show in the log of each bridge using them (the AI client's MCP log), tagged with the server name. A warning that is only given once, such as the `"sse"` deprecation, shows in the bridges using the upstream at that moment.

A bridge from crabeye 1.3.0 or earlier still connects to HTTP and SSE servers itself.

## Protocol versions

The manager connects each STDIO server once, however many bridges use it, and starts every new server process the same way, including after the manager itself restarts. It first asks the server which protocol versions it speaks; a server on the 2026-07-28 protocol answers, and any other answer makes the manager go on with an `initialize` handshake. Nothing else reaches the server before that handshake, so servers that refuse requests before it work after any restart.

A server that doesn't answer the question within about 10 seconds, or quits when asked, is started again at once and connected to with an `initialize` handshake straight away. Once that handshake works, the manager remembers this until it stops, so later starts of the same server skip the question and `daemon status` shows it as `legacy`. That includes a server on the 2026-07-28 protocol whose first start took longer than that, such as a first `npx -y` download; it keeps working through the handshake.

## CLI

A bridge starts the manager as soon as its config has an upstream, STDIO or HTTP. The `daemon` subcommand exists for manual control:

```bash
crabeye-mcp-bridge daemon start      # spawn the manager (no-op if one it doesn't need to replace is running)
crabeye-mcp-bridge daemon stop       # graceful shutdown; stops an unresponsive manager too
crabeye-mcp-bridge daemon status     # pid, uptime, crabeye version, each STDIO server's protocol, the configs and upstreams in use, and the log file
crabeye-mcp-bridge daemon restart    # stop + start
```

`daemon status` lists the STDIO servers the manager runs under `children`, each with its protocol: `modern` (2026-07-28), `legacy` (an earlier version), or `unknown` (not known yet), and the `upstreamHash` that `daemon restart-upstream` takes. It shows `null` when the manager can't be asked or doesn't report protocols.

It lists the configs the manager loaded for bridges under `instances`, each with:

* `config`: its file;
* `kind`: `file` for a `--config` file or `MCP_BRIDGE_CONFIG`, `merged` for the default set read through `~/.crabeye-mcp-bridge/config.json`;
* `bridges`: the number of bridges attached;
* `servers`: the servers it uses.

The upstreams the manager connects are under `upstreams`, each with:

* `server`: its name;
* `type`: `stdio`, `streamable-http` or `sse`;
* `state`: `connecting`, `connected`, `disconnected` or `auth_required`;
* `instances`: how many of those configs share it;
* `upstreamHash`: for a STDIO server, what `daemon restart-upstream` takes, whether or not its process is running.

Both show `null` when the manager can't be asked or doesn't report them.

`crabeye-mcp-bridge daemon --internal-launch` is a hidden, internal-only entrypoint used by the bridge to fork the manager process. Don't use it directly.

### Restarting a single upstream

If a server's program is updated on disk but its config entry is unchanged (e.g. `npm update -g`, `brew upgrade`, dev rebuild), the manager won't notice. Restart that server, by the `upstreamHash` that `daemon status` shows for it under `upstreams`, or every STDIO server, including one waiting to be started again:

```bash
crabeye-mcp-bridge daemon restart-upstream <upstreamHash>
crabeye-mcp-bridge daemon restart-upstream --all
```

Calls still running on the stopped server fail with `upstream restarted`. The manager starts the server again and every bridge using it gets the new one, so the next tool call goes through without restarting the client.

The manager does the same when a server crashes, stops answering its pings, or floods its output; calls running on it then fail with `child process exited` or `child not answering pings`.

## Configuration knobs

All knobs live under `_bridge.daemon.*` in the bridge config:

| Key | Default | Meaning |
|-----|---------|---------|
| `idleMs` | `60000` | A config's connections and STDIO servers are let go this long after the last bridge using it disconnects, unless another config still uses them. The manager exits this long after it has nothing left. |
| `graceMs` | `60000` | A STDIO server keeps running this long after the last config using it is let go, in case a bridge starts using it again. |
| `rpcTimeoutMs` | `30000` | How long a bridge waits for the manager to answer when it connects to it and checks on it. A manager that doesn't answer a check in time is replaced. |
| `heartbeatMs` | `5000` | How often a bridge checks that the manager is still answering. A manager that misses three checks in a row is replaced, even when no call is running. |

`rpcTimeoutMs` and `heartbeatMs` apply to each bridge's one connection to the manager, whatever servers it uses. The manager exits roughly `2 × idleMs + graceMs` (≈3 min by default) after the last bridge disconnects, or `2 × idleMs` when it ran no STDIO server.

## What happens when I edit my MCP config and save?

The manager follows edits to the client config files and `--config` files it loaded and applies them once for every bridge. An edit to `~/.crabeye-mcp-bridge/config.json` itself applies once any client restarts.

1. **A change to how a STDIO server is started or connected** (its `command`, `args`, `env`, `cwd` or `_bridge.reconnect`, or the global `_bridge.reconnect`) starts the server again with the new settings. The old process stops once no config uses it any more (after `graceMs`). **No manual action needed.**

2. **A change that only renames a server, or adds a second name for the same command,** keeps the running server.

3. **A change to nothing the manager starts the server with** (e.g. you only edited `_bridge.toolPolicy`, or you upgraded the server's program on disk in place) keeps the running server. The bridge picks up the policy change, but running the new program needs:

   ```bash
   crabeye-mcp-bridge daemon restart-upstream <upstreamHash>
   ```

   This is the only case where you need to invoke the `daemon` CLI manually.

For HTTP and SSE upstreams, a changed URL, header or `_bridge.auth` reconnects the server, and an added or removed server appears or goes away for every client.

### Where do paths live?

* **Unix:** UDS at `~/.crabeye/run/manager.sock` (mode `0600`), pidfile at `~/.crabeye/run/manager.pid`, lockfile at `~/.crabeye/run/manager.lock`.
* **Long home directories:** socket paths are limited in length (100 bytes). When `~/.crabeye/run/manager.sock` is longer, the bridge and manager reach it through a short link named `crabeye-<hash>` in your private temporary directory (`$TMPDIR` on macOS, `$XDG_RUNTIME_DIR` or `/run/user/<uid>` on Linux); the socket, pidfile and lockfile stay in `~/.crabeye/run`. If no private temporary directory is available, the manager fails to start with an error giving the path and the limit.
* **Windows:** named pipe restricted to the current user.
* **Manager log:** see [Manager log](#manager-log).

## Failure handling

* **Manager crash / SIGKILL.** The bridge notices its connection close and, unless another manager already answers, starts a new manager (lock-first to mitigate recycled-pid hazards). Calls that were running fail with `daemon connection closed`; calls made after that wait for the new manager and run once on it. The new manager starts every STDIO server again.
* **Stalled manager.** The bridge's heartbeat or a call to the manager times out; the bridge stops the manager through `manager.pid` and starts a new one, with the same effect on calls.
* **Unresponsive manager with no bridge connected.** When the manager recorded in `manager.lock` (or `manager.pid`) is running but doesn't answer, a bridge waits up to a minute in case it is still starting up. If it still doesn't answer, the bridge stops it and starts a fresh one, but only after confirming the process is a crabeye manager, and it replaces it at most once per attempt. When several bridges hit this at once, only one of them does the replacement. If the recorded pid now belongs to an unrelated program, the bridge ignores it and starts a manager. If the process can't be identified, the bridge leaves it running and asks you to run `crabeye-mcp-bridge daemon stop`; if something holds the socket with no manager recorded, it reports the socket so you can stop whatever is holding it.
* **Two-bridge race.** Loser blocks on `manager.lock` for up to `respawnLockWaitMs` (60s default), then ensures a manager anyway and connects to whichever manager process ended up bound to the socket. Only one manager can own the socket; extras exit on their own.
* **Orphaned children from a dead manager.** Each manager stops the STDIO servers a previous crashed manager left running before it serves any connection.

## Notifications from servers

When a STDIO server's tool list changes, every bridge using it updates its search. Other notifications a server sends, such as progress or log messages, aren't passed on; what a server writes to stderr appears in the bridge log instead (see below).

## Upstream stderr

Whatever a STDIO server writes to stderr shows up in the log of every bridge using it, at debug level, tagged with that bridge's name for the server. To see it, set `_bridge.logLevel` to `"debug"`. Control characters in these lines are escaped like any other log text. Very long lines are cut off, and when a server writes more than 100 lines a second, the extra lines are left out and the bridge logs how many.

When a STDIO server stops (it can't be started, exits, crashes, stops answering, or is stopped for sending a message too large to read), every bridge using it logs a warning at the default log level with the server's last stderr lines. A server that fails at startup usually says why there, for example a missing token. If the command itself can't be started, the warning shows the error from starting it. While a server keeps failing the same way without connecting in between, later warnings are logged at debug level.

## Manager log

The manager writes what it does to a log file:

* **macOS and Linux:** `~/.crabeye/logs/daemon.log`
* **Windows:** `%LOCALAPPDATA%\crabeye\logs\daemon.log`

`daemon status` prints the path as `logFile`, whether or not a manager is running. A manager from crabeye 1.3.0 or earlier writes no log, so while one is running the file may be missing or end at an earlier time. On macOS and Linux, the directory and the file are readable only by you. The log calls the manager "daemon".

The log records:

* the manager starting and stopping, and why it stopped (asked to, idle, a signal, another manager taking over, or a crash, with its error);
* a start that fails, with the error, and a start that finds a manager already running and leaves it to serve;
* waiting for a previous manager to exit, and taking over from one that is no longer running;
* the STDIO servers a bridge from crabeye 1.3.0 or earlier asks for being refused, at most once a minute, with how many;
* bridges attaching to and detaching from a config, a config that can't be loaded (and why), servers added, removed or reconnected after an edit, and servers connected again after `crabeye-mcp-bridge auth` or `auth --remove`;
* HTTP and SSE upstreams connecting, failing to connect, being paused for authorization, failing health checks, and their other warnings;
* STDIO servers starting, failing to connect, exiting on their own (with their exit code or signal), and being stopped (idle, not answering pings, restarted, shutting down, or after quitting when asked which protocol versions they speak).

At debug level it also records what servers write to stderr, tagged with the server name, with the same 100-lines-a-second limit as in bridge logs. Each line starts with the date, the time with its UTC offset, and the manager's process id, so the lines of two managers running at the same time (a new one waiting for the old one) can be told apart.

The level comes from `_bridge.logLevel` in `~/.crabeye-mcp-bridge/config.json` and is read when the manager starts; run `crabeye-mcp-bridge daemon restart` after changing it. The log is always plain text, whatever `_bridge.logFormat` is set to. If that file can't be read or isn't valid, the manager logs a warning and uses the defaults.

The manager doesn't record environment values or command-line arguments. It does record server names, process ids, the command of a server that can't be started, the path of a config file a bridge asked for that can't be loaded, the path of a certificate file it can't read, the names and locations of invalid settings and why they're invalid (for a URL that can include its host, never its credentials), and, after a crash, the error with its stack. When a server writes something other than protocol messages to its output, the log says how many such lines there were, not what they said. Because servers can echo secrets to stderr, check a debug-level log before sharing it.

Before the file would grow past 10 MB, it is renamed to `daemon.log.1`, replacing the previous one, and a new `daemon.log` is started. If it can't be renamed (for example because another program has `daemon.log.1` open on Windows), it is emptied instead. If the log can't be written, the manager keeps running without it.

## Requests from upstream servers

An upstream can send requests to its client: to ask the user something (elicitation), to have the assistant's model write something (sampling), or to list the client's roots. The bridge supports none of these, so the manager answers them itself. A `ping` gets a normal reply; anything else gets an error saying the client doesn't support it. The server keeps serving every bridge using it.

When an upstream answers a tool call by asking for client input, the call fails with an error naming the upstream and saying the bridge doesn't support requests for client input.

## After upgrading crabeye

A manager started by an older crabeye version keeps running after an upgrade for as long as a bridge uses it. When a bridge from the new version finds one, it stops it and starts a manager of its own version in its place. Bridges still using the old manager reconnect to the new one on their own; calls they had in flight fail once. A manager of the same or a newer version is used as is. A bridge from a pre-release version (such as `2.1.0-beta.1`) only replaces an older pre-release manager, never a release one or one that reports no version, unless that manager is too old for the bridge to talk to.

**Upgrading from crabeye 1.3.0 or earlier: restart every AI client.** This version's manager runs no STDIO server for a bridge from crabeye 1.3.0 or earlier. Such a bridge keeps the manager running and its HTTP and SSE servers keep working, but each of its STDIO servers fails: a bridge started after the upgrade logs an error saying to restart the AI client, and one started before it reports the server as failed. Restarting the AI client starts the new bridge, and its STDIO servers work again.

A bridge tries this once. A client that was started before the upgrade and runs the old version from its own install (for example a cached `npx` copy) can start the old manager again whenever it loses its connection. When a new bridge ends up on an old manager that way, or could not replace it, it logs a warning once for that manager; bridges use whichever manager is running until those clients restart. A manager from crabeye 1.3.0 or earlier is too old for this version's bridges: when one can't be replaced, their STDIO servers fail to start, and the HTTP servers the manager would connect fail to connect, with the error described below.

If a newer manager no longer accepts bridges as old as this one, the bridge's STDIO servers fail to start, and the HTTP servers the manager would connect fail to connect, with an error saying so. Upgrading crabeye fixes it. The same happens when a manager is too old for the bridge to talk to and can't be replaced; `crabeye-mcp-bridge daemon stop` fixes that.

`crabeye-mcp-bridge daemon start` replaces an older manager the same way. It exits with an error if an older one is still running afterwards, or if the running manager no longer accepts this bridge or is too old for the bridge to talk to.

## Telemetry

The manager also keeps counters about its STDIO servers. `daemon status` doesn't print them; tools that ask the manager for its status directly get them alongside `children`, `instances` and `upstreams`:

```jsonc
{
  "uptime": 1234567,
  "pid": 8412,
  "version": 4,
  "appVersion": "2.0.0",                 // crabeye version of this manager
  "children": [ /* ... */ ],             // STDIO servers it runs
  "instances": [ /* ... */ ],            // configs loaded for bridges
  "upstreams": [ /* ... */ ],            // upstreams it connects
  "telemetry": {
    "children": {
      "total": 3,                        // gauge: live children right now
      "spawnedTotal": 12,                // counter: spawns since manager start
      "killedTotal": {
        "grace": 7, "restart": 2,
        "crash": 0, "wedged": 0
      }
    },
    "rpc": {
      "inFlight": 1,                     // gauge
      "errorsTotal": { "invalid_params": 3 }
    }
  }
}
```

All counters are **process-lifetime** — they reset to zero on manager respawn. Observers detect a respawn by watching `uptime` go backwards.

`killedTotal` reasons:

* **`grace`** — no config used the server for `graceMs`.
* **`restart`** — `daemon restart-upstream`.
* **`crash`** — the server exited on its own (any exit code, or a signal the manager did not send), couldn't be started, closed its output, or was stopped for flooding its output without line breaks.
* **`wedged`** — the server stopped answering the manager's pings and was started again.

### Force-respawn events (bridge-side)

Bridge force-respawns of the manager are **not** counted in `killedTotal` — by the time the new manager is up the old one is gone. Each one shows up as an INFO line in the log of the bridge that started the new manager:

```jsonc
{ "level": "info", "msg": "force_respawn", "component": "daemon",
  "event": "force_respawn",
  "reason": "heartbeat_miss" | "rpc_timeout" | "socket_close" }
```

A bridge that loses its connection while another manager already answers on the socket (for example a duplicate manager stepping down for the one that owns the socket) reconnects without starting one; that reconnect logs the same line with `reason: "socket_close"`.
