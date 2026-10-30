# STDIO manager

The STDIO manager is a per-user background process the bridge spawns automatically. It owns every STDIO upstream MCP server and lets multiple bridges share one subprocess per upstream — so running Claude Desktop, Cursor, and a CLI bridge against the same Linear MCP server doesn't spawn three copies of the Linear MCP server.

The manager also connects every HTTP and SSE upstream, once for every bridge that uses them (see [HTTP and SSE upstreams](#http-and-sse-upstreams)). There is no inline fallback for either kind: when the manager can't be started or reached, those upstreams fail to connect and say why, and the bridge keeps trying.

## Why it exists

Without the manager, every running bridge spawns its own copy of every configured STDIO upstream MCP server. Run **N bridges** (one per editor / agent) against **M servers** and you get **N × M subprocesses**. Each one consumes its own RAM, file handles, and re-runs the upstream's auth handshake.

The manager collapses this: it owns the STDIO subprocesses and multiplexes sessions from every bridge. Identical upstream specs across bridges share a single child.

![Per-bridge topology: each bridge spawns its own copy of every STDIO upstream server, leading to N × M subprocesses across the system.](img/topology-per-bridge.png)

![Manager-shared topology: every bridge connects to a single per-user manager process over UDS / named pipe; the manager owns one shared subprocess per unique upstream spec across all bridges.](img/topology-daemon-shared.png)

## How sharing works

Each upstream is identified by an **`upstreamHash`** — a SHA-256 of the canonical form of `(command, args, resolvedEnv, cwd)`. Every bridge whose upstream has the same hash shares one child; different credentials → different hash → different child. The server's name in your config doesn't count, so two entries with different names but the same command, arguments, environment and working directory share a child.

`_bridge.sharing` and the `_bridge.daemon` auto-fork settings no longer exist; the bridge ignores them and logs a warning when a config still sets them.

A shared child serves all of its bridges at once. A server that keeps state in memory, such as a browser it opened, shares that state with every assistant using it. To keep two copies of a server apart, give them different `env` or `args`.

The bridge dedupes config entries by `upstreamHash` locally — duplicate identical entries collapse to one session before reaching the manager.

## HTTP and SSE upstreams

The manager connects every HTTP and SSE upstream, including servers you authorized with `crabeye-mcp-bridge auth <server>` and no config change.

Bridges that load the same config share the manager's copy of it: the same `--config` file (or `MCP_BRIDGE_CONFIG`), or, without either, the default set made of `~/.crabeye-mcp-bridge/config.json` and the client config files it lists. A bridge whose MCP entry sets different values for any of these variables gets its own copy, so it never uses another client's credentials or network settings:

* `MCP_BRIDGE_MASTER_KEY`;
* the variables a `clientSecret` can name (see [the naming rule](auth.md#confidential-clients));
* the network settings below.

The manager connects each client's HTTP and SSE upstreams with that client's network settings, not with its own:

* it checks certificates unless the client sets `NODE_TLS_REJECT_UNAUTHORIZED=0`;
* it trusts Node's own certificates, the certificates in the client's `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`, and the system's certificates when the client sets `NODE_USE_SYSTEM_CA=1` or runs Node with `--use-system-ca`;
* it goes through the client's `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` (upper or lower case) when the client sets `NODE_USE_ENV_PROXY=1` or runs Node with `--use-env-proxy`.

A setting that makes no difference, such as a proxy variable without `NODE_USE_ENV_PROXY=1`, doesn't give a client its own copy. The manager reads a client's certificate files when it opens that client's connection; after you change one, run `crabeye-mcp-bridge daemon restart`.

The manager runs without `NODE_OPTIONS`. A bridge whose Node options would change its connections in other ways, such as `--use-openssl-ca`, `--tls-min-v1.3` or `--require` for a proxy agent, logs a warning naming them, since the manager doesn't apply them.

The manager's own `OPENSSL_CONF`, from the client whose bridge started it, applies to every client. Its `SSL_CERT_DIR`, on Node builds that read it, applies only to clients whose certificate settings are the same as its own and that set no `SSL_CERT_FILE`. On Linux, the system's certificates are read with the manager's own `SSL_CERT_FILE` and `SSL_CERT_DIR`.

Each upstream gets one connection for all of these bridges. Two entries share a connection, even across configs, if they have the same server name, transport, URL, headers (as written, before `${credential:…}` is filled in), `_bridge.auth` settings, master key, value of the variable their `clientSecret` names, and network settings. A server on the 2026-07-28 protocol sees one client, and a server on an earlier protocol sees one session. When a server ends that session, the manager starts one new session for everyone once the connection closes or three health checks in a row fail.

The manager:

* reads the config files, the credential store and the keychain itself, and fills in `${credential:…}` header values on every connect, so a changed credential is used from the next connect on;
* checks each connection's health once, with the `healthCheckInterval` of the longest-standing config using it and the reconnect settings of the config that first needed it;
* uses and refreshes stored OAuth tokens for every bridge at once, so clients don't each refresh an expired token, even when their settings give them separate connections to the server, and pauses an upstream that needs authorization for every bridge at once;
* reads a `clientSecret` from the variables of the client the connection is for, never from its own environment;
* connects a server again for every bridge as soon as `crabeye-mcp-bridge auth <server>` or `auth --remove <server>` changes its stored credentials;
* follows edits to the files it loaded (the `--config` file, or the client config files), applying a change once for every bridge;
* reads the config again whenever another bridge starts using it.

When an HTTP or SSE server's URL, headers or `_bridge.auth` change in `~/.crabeye-mcp-bridge/config.json`, its connection follows the edit for every client once any client restarts. If the edit removes the server, clients that haven't restarted can't use it until they restart. A changed `healthCheckInterval` also applies to these connections once any client restarts, while changed reconnect settings apply only to connections opened after the edit. Everything else in that file takes effect for each client when that client restarts.

What `search_tools` and `run_tool` show doesn't change: each bridge still applies its own tool policy, rate limits and passthrough settings. Cancelling a call cancels it at the server, and each server's instructions reach every client.

The [manager log](#manager-log) records what happens to these upstreams. Their warnings and errors also show in the log of each bridge using them (the AI client's MCP log), tagged with the server name. A warning that is only given once, such as the `"sse"` deprecation, shows in the bridges using the upstream at that moment.

A config's connections stay open while a bridge uses that config, and for `_bridge.daemon.idleMs` after the last such bridge disconnects; a bridge that starts in between reuses them instead of connecting again.

If the manager is stopped or replaced while a call is running, that call fails with `daemon shutdown`, or with `daemon connection closed` when the manager crashes or is killed. The bridge starts a new manager, and later calls go through without restarting the client. A tool result too large for the manager to pass on (over 16 MB) fails with an error saying so.

A bridge from crabeye 1.3.0 or earlier still connects to HTTP and SSE servers itself.

## Initialize and protocol-version cache

The first bridge session against a child runs a real `initialize` round-trip. The manager caches the result and replays it on every subsequent session's `initialize` for the same child — the call never reaches the child a second time. The cache covers `protocolVersion`, `serverInfo`, `capabilities`, and (when the upstream advertises one) the `instructions` text used by the bridge's [`_bridge.passthrough`](configuration.md#context-passthrough) feature, so all sessions see the same instructions regardless of attach order.

Servers on the 2026-07-28 protocol skip `initialize`, and bridges ask them which protocol versions they speak instead. The manager remembers each child's answer once a bridge has gone on to use the 2026-07-28 protocol with it, so only the checks made before then reach the child. Later bridges, reconnects and health checks get the remembered answer. The manager forgets the answer when the child stops, so a restarted or upgraded server is asked again. If the child ping is turned off (`_bridge.daemon.childPingMs: 0`), every check still reaches a 2026-07-28 server, so a stuck child is still noticed.

A server settles on one protocol from the first message it gets other than this question. So when anything else reaches it first (an `initialize` from a bridge that gave up waiting on a slow first start or from crabeye 1.3.0 or earlier, the manager's own health check, or a cancelled request), the manager doesn't keep the server's answer to an earlier check, whether it has arrived yet or not: the next check asks the server again, and its reply decides. The manager never passes on the cancellation of a check, so a bridge that quits while its check is waiting doesn't change the protocol for the others. A server that answers the question with an error (other than one saying it doesn't support the version asked for) is remembered straight away. If a server ignores the question, as some older servers do, only the bridges that connect before the first check gives up (about 10 seconds) have to wait; later bridges are told straight away that the server doesn't speak the 2026-07-28 protocol.

## CLI

A bridge starts the manager as soon as its config has an upstream, STDIO or HTTP. The `daemon` subcommand exists for manual control:

```bash
crabeye-mcp-bridge daemon start      # spawn the manager (no-op if one it doesn't need to replace is running)
crabeye-mcp-bridge daemon stop       # graceful shutdown; stops an unresponsive manager too
crabeye-mcp-bridge daemon status     # pid, uptime, crabeye version, refused upstream requests, each server's protocol, the configs and HTTP upstreams in use, and the log file
crabeye-mcp-bridge daemon restart    # stop + start
```

`daemon status` lists the servers bridges are using under `children`, each with its protocol: `modern` (2026-07-28), `legacy` (an earlier version), or `unknown` (not known yet). It shows `null` when the manager can't be asked or doesn't report protocols (managers from crabeye 1.3.0 or earlier don't).

It lists the configs the manager loaded for bridges under `instances`, each with:

* `config`: its file;
* `kind`: `file` for a `--config` file or `MCP_BRIDGE_CONFIG`, `merged` for the default set read through `~/.crabeye-mcp-bridge/config.json`;
* `bridges`: the number of bridges attached;
* `servers`: the HTTP and SSE servers it connects.

The HTTP and SSE upstreams it connects are under `httpUpstreams`, each with:

* `server`: its name;
* `state`: `connecting`, `connected`, `disconnected` or `auth_required`;
* `instances`: how many of those configs share it.

Both show `null` when the manager can't be asked or doesn't report them.

`crabeye-mcp-bridge daemon --internal-launch` is a hidden, internal-only entrypoint used by the bridge to fork the manager process. Don't use it directly.

### Restarting a single upstream

If the upstream binary is updated on disk but its `upstreamHash` is unchanged (e.g. `npm update -g`, `brew upgrade`, dev rebuild), the manager won't notice — its hash hasn't changed. Trigger a forced respawn manually:

```bash
crabeye-mcp-bridge daemon restart-upstream <upstreamHash>
crabeye-mcp-bridge daemon restart-upstream --all
```

Requests still in flight on the killed child fail with an "upstream restarted" error. Each bridge using that child reconnects on its own and gets a fresh child, so the next tool call goes through without restarting the client.

The same happens when a child crashes, stops answering health pings, or floods its output: its bridges reconnect to a fresh child instead of waiting for requests to time out.

## Configuration knobs

All knobs live under `_bridge.daemon.*` in the bridge config:

| Key | Default | Meaning |
|-----|---------|---------|
| `idleMs` | `60000` | The manager self-exits this long after the last bridge disconnects. A config's HTTP connections close this long after the last bridge using it disconnects, unless another config still uses them. |
| `graceMs` | `60000` | A child stays alive this long after its last session detaches, in case another bridge reattaches. |
| `rpcTimeoutMs` | `30000` | Per-RPC timeout on outbound bridge→manager calls. Stalled responses past this trigger a force-respawn. |
| `heartbeatMs` | `5000` | Bridge sends a PING this often. Missed heartbeat (`heartbeatMs * 3`) trips force-respawn even with zero in-flight RPCs. |

The child grace timer and the manager's idle timer compose independently — the manager exits roughly `graceMs + idleMs` (≈2 min by default) after the last bridge disconnects, or `2 × idleMs` when it only had HTTP upstreams.

## What happens when I edit my MCP config and save?

Bridge has hot-reload: it reads the saved config and reconciles upstream sessions. Two cases:

1. **The config change mutates the `upstreamHash`** (e.g. you changed `args`, `command`, `env`, or `cwd`). The bridge OPENs a fresh session against the new spec; the manager spawns a new child for the new hash. The old child grace-kills once its refcount drops to zero. **No manual action needed.**

2. **The config change does NOT mutate the `upstreamHash`** (e.g. you only edited `_bridge.toolPolicy`, or you upgraded the upstream binary on disk in place). The manager still has the old child cached. Bridge picks up the policy change, but the *binary* hot-swap requires:

   ```bash
   crabeye-mcp-bridge daemon restart-upstream <hash>
   ```

   This is the only case where you need to invoke the `daemon` CLI manually.

For HTTP and SSE upstreams the manager connects, it applies the edit itself, once for every bridge: a changed URL, header or `_bridge.auth` reconnects the server, and an added or removed server appears or goes away for every client.

### Where do paths live?

* **Unix:** UDS at `~/.crabeye/run/manager.sock` (mode `0600`), pidfile at `~/.crabeye/run/manager.pid`, lockfile at `~/.crabeye/run/manager.lock`.
* **Long home directories:** socket paths are limited in length (100 bytes). When `~/.crabeye/run/manager.sock` is longer, the bridge and manager reach it through a short link named `crabeye-<hash>` in your private temporary directory (`$TMPDIR` on macOS, `$XDG_RUNTIME_DIR` or `/run/user/<uid>` on Linux); the socket, pidfile and lockfile stay in `~/.crabeye/run`. If no private temporary directory is available, the manager fails to start with an error giving the path and the limit.
* **Windows:** named pipe restricted to the current user.
* **Manager log:** see [Manager log](#manager-log).

## Failure handling

* **Manager crash / SIGKILL.** Bridge detects via socket close and, unless another manager already answers on the socket, force-respawns the manager (lock-first to mitigate recycled-pid hazards), then re-OPENs every session. Read-only in-flight requests (`tools/list`, `prompts/list`, `resources/list`, `resources/read`, `resources/templates/list`, `prompts/get`) silently retry; everything else surfaces `ERR_UPSTREAM_RESTARTED { reason: "daemon_respawn" }`. Calls made after the bridge notices the lost connection wait and run once on the new manager; if the respawn fails, they fail with the same restart error. For the HTTP and SSE upstreams the manager connects, every call in flight fails with `daemon connection closed` instead, and calls made while the new manager starts wait for it.
* **Stalled manager (RPC handler sleeps).** Bridge's heartbeat watchdog or per-RPC timeout fires; the bridge SIGKILLs the manager via `manager.pid` and respawns.
* **Unresponsive manager with no bridge connected.** When the manager recorded in `manager.lock` (or `manager.pid`) is running but doesn't answer, a bridge waits up to a minute in case it is still starting up. If it still doesn't answer, the bridge stops it and starts a fresh one, but only after confirming the process is a crabeye manager, and it replaces it at most once per attempt. When several bridges hit this at once, only one of them does the replacement. If the recorded pid now belongs to an unrelated program, the bridge ignores it and starts a manager. If the process can't be identified, the bridge leaves it running and asks you to run `crabeye-mcp-bridge daemon stop`; if something holds the socket with no manager recorded, it reports the socket so you can stop whatever is holding it.
* **Two-bridge race.** Loser blocks on `manager.lock` for up to `rpcTimeoutMs * 2` (60s default), then ensures a manager anyway and connects to whichever manager process ended up bound to the socket. Only one manager can own the socket; extras exit on their own.
* **Orphaned children from a dead manager.** Each manager runs `ProcessTracker.reapStale()` on startup so children leaked by a previous crashed manager get reaped before the new manager serves any connection.

## Notification fan-out

The manager broadcasts certain upstream notifications across every session sharing the child:

| Notification | Manager behavior | Forwarded to MCP client? |
|--------------|------------------|--------------------------|
| `notifications/tools/list_changed` | Broadcast to every attached session. | No — each bridge re-indexes its search; its own tool list never changes. |
| `notifications/prompts/list_changed` | Broadcast to every attached session. | No — bridge does not implement this surface. |
| `notifications/resources/list_changed` | Broadcast to every attached session. | No — bridge does not implement this surface. |
| `notifications/resources/updated` | Routed by per-session subscription tracker (only sessions that subscribed get the notification). | Yes. |
| `notifications/progress`, `notifications/cancelled` | Routed to the originating session via rewritten progress/request tokens. | Yes. |
| Notifications for a 2026-07-28 subscription (its confirmation, and the changes it asked for) | Routed only to the session that opened the subscription; dropped once it has ended. | No — the bridge handles them itself (a tool-list change re-indexes its search). |

Log messages an upstream sends as notifications are dropped; what a server writes to stderr appears in the bridge log instead (see below).

## Upstream stderr

Whatever a STDIO server writes to stderr shows up in the log of every bridge using it, at debug level, tagged with that bridge's name for the server. To see it, set `_bridge.logLevel` to `"debug"`. Control characters in these lines are escaped like any other log text. Very long lines are cut off, and when a server writes more than 100 lines a second, the extra lines are left out and the bridge logs how many.

When a STDIO server stops (it can't be started, exits, crashes, stops answering, or is stopped for sending a message too large to read), every bridge using it logs a warning at the default log level with the server's last stderr lines. A server that fails at startup usually says why there, for example a missing token. If the command itself can't be started, the warning shows the error from starting it. While a server keeps failing the same way without connecting in between, later warnings are logged at debug level. A bridge from crabeye 1.3.0 or earlier doesn't receive any of this, and no bridge does while it uses a manager from crabeye 1.3.0 or earlier.

## Manager log

The manager writes what it does to a log file:

* **macOS and Linux:** `~/.crabeye/logs/daemon.log`
* **Windows:** `%LOCALAPPDATA%\crabeye\logs\daemon.log`

`daemon status` prints the path as `logFile`, whether or not a manager is running. A manager from crabeye 1.3.0 or earlier writes no log, so while one is running the file may be missing or end at an earlier time. On macOS and Linux, the directory and the file are readable only by you. The log calls the manager "daemon".

The log records:

* the manager starting and stopping, and why it stopped (asked to, idle, a signal, another manager taking over, or a crash, with its error);
* a start that fails, with the error, and a start that finds a manager already running and leaves it to serve;
* waiting for a previous manager to exit, and taking over from one that is no longer running;
* sessions opening, closing (and why), and being refused (and why);
* bridges attaching to and detaching from a config, a config that can't be loaded (and why), servers added, removed or reconnected after an edit, and servers connected again after `crabeye-mcp-bridge auth` or `auth --remove`;
* HTTP and SSE upstreams connecting, failing to connect, being paused for authorization, failing health checks, and their other warnings;
* STDIO servers starting, exiting on their own (with their exit code or signal), and being stopped (idle, not answering pings, restarted, or shutting down).

At debug level it also records what servers write to stderr, tagged with the server name, with the same 100-lines-a-second limit as in bridge logs. Each line starts with the date, the time with its UTC offset, and the manager's process id, so the lines of two managers running at the same time (a new one waiting for the old one) can be told apart.

The level comes from `_bridge.logLevel` in `~/.crabeye-mcp-bridge/config.json` and is read when the manager starts; run `crabeye-mcp-bridge daemon restart` after changing it. The log is always plain text, whatever `_bridge.logFormat` is set to. If that file can't be read or isn't valid, the manager logs a warning and uses the defaults.

The manager doesn't record environment values or command-line arguments. It does record server names, session and process ids, the command of a server that can't be started, the path of a config file a bridge asked for that can't be loaded, the path of a certificate file it can't read, the names and locations of invalid settings and why they're invalid (for a URL that can include its host, never its credentials), and, after a crash, the error with its stack. When a server writes something other than protocol messages to its output, the log says how many such lines there were, not what they said. Because servers can echo secrets to stderr, check a debug-level log before sharing it.

Before the file would grow past 10 MB, it is renamed to `daemon.log.1`, replacing the previous one, and a new `daemon.log` is started. If it can't be renamed (for example because another program has `daemon.log.1` open on Windows), it is emptied instead. If the log can't be written, the manager keeps running without it.

## Requests from upstream servers

An upstream can send requests to its client: to ask the user something (elicitation), to have the assistant's model write something (sampling), or to list the client's roots. The bridge supports none of these, so the manager answers them itself. A `ping` gets a normal reply; anything else gets an error saying the bridge doesn't support it. The child keeps serving every bridge attached to it. `daemon status` counts the refused requests by method under `refusedUpstreamRequests`, so you can see when a server asked for something the bridge can't provide.

When an upstream answers a tool call by asking for client input, the call fails with an error naming the upstream and saying the bridge doesn't support requests for client input.

## After upgrading crabeye

A manager started by an older crabeye version keeps running after an upgrade for as long as a bridge uses it. When a bridge from the new version finds one, it stops it and starts a manager of its own version in its place. Bridges still using the old manager reconnect to the new one on their own; calls they had in flight fail once. A bridge from crabeye 1.3.0 or earlier sometimes waits up to its `_bridge.daemon.respawnLockWaitMs` setting (one minute by default) before it reconnects. A manager of the same or a newer version is used as is. A bridge from a pre-release version (such as `2.1.0-beta.1`) only replaces an older pre-release manager, never a release one or one that reports no version, unless that manager is too old for the bridge to talk to.

A bridge tries this once. A client that was started before the upgrade and runs the old version from its own install (for example a cached `npx` copy) can start the old manager again whenever it loses its connection. When a new bridge ends up on an old manager that way, or could not replace it, it logs a warning once for that manager; bridges use whichever manager is running until those clients restart. A manager from crabeye 1.3.0 or earlier is too old for this version's bridges: when one can't be replaced, their STDIO servers fail to start, and the HTTP servers the manager would connect fail to connect, with the error described below.

If a newer manager no longer accepts bridges as old as this one, the bridge's STDIO servers fail to start, and the HTTP servers the manager would connect fail to connect, with an error saying so. Upgrading crabeye fixes it. The same happens when a manager is too old for the bridge to talk to and can't be replaced; `crabeye-mcp-bridge daemon stop` fixes that.

`crabeye-mcp-bridge daemon start` replaces an older manager the same way. It exits with an error if an older one is still running afterwards, or if the running manager no longer accepts this bridge or is too old for the bridge to talk to.

## Telemetry

The manager's `STATUS` RPC returns a `telemetry` object alongside the existing `children[]` and `sessions[]` arrays:

```jsonc
{
  "uptime": 1234567,
  "pid": 8412,
  "version": 3,
  "appVersion": "2.0.0",                 // crabeye version of this manager
  "children": [ /* ... */ ],
  "sessions": [ /* ... */ ],
  "instances": [ /* ... */ ],            // configs loaded for bridges
  "httpUpstreams": [ /* ... */ ],        // HTTP and SSE upstreams the manager connects
  "telemetry": {
    "children": {
      "total": 3,                        // gauge: live children right now
      "spawnedTotal": 12,                // counter: spawns since manager start
      "killedTotal": {
        "grace": 7, "restart": 2,
        "crash": 0, "wedged": 0
      }
    },
    "sessions": {
      "total": 5,                        // gauge: live sessions right now
      "openedTotal": 24,
      "closedTotal": 19
    },
    "rpc": {
      "inFlight": 1,                     // gauge
      "errorsTotal": { "invalid_params": 3 }
    },
    "upstreamRequests": {
      "refusedTotal": { "sampling/createMessage": 2 }  // requests from upstreams the manager refused, by method
    }
  }
}
```

All counters are **process-lifetime** — they reset to zero on manager respawn. Observers detect a respawn by watching `uptime` go backwards.

`killedTotal` reasons:

* **`grace`** — refcount dropped to zero and the `graceMs` timer fired.
* **`restart`** — admin `RESTART` RPC (CLI `daemon restart-upstream`).
* **`crash`** — child exited on its own (any exit code, or a signal the manager did not send), or was killed for flooding its output without line breaks.
* **`wedged`** — child stopped answering the manager's health pings and was killed.

### Force-respawn events (bridge-side)

Bridge force-respawns of the manager are **not** counted in `killedTotal` — by the time the new manager is up the old one is gone. Each force-respawn shows up as a structured INFO log line emitted by the bridge:

```jsonc
{ "level": "info", "msg": "force_respawn", "component": "daemon-stdio",
  "event": "force_respawn",
  "reason": "heartbeat_miss" | "rpc_timeout" | "socket_close",
  "sessionId": "<uuid>", "sessionsReopened": 1 }
```

Each manager-stdio transport in the bridge owns one session, so each transport emits one log line per respawn it observes. A bridge that loses its connection while another manager already answers on the socket (for example a duplicate manager stepping down for the one that owns the socket) reconnects and re-OPENs without respawning; that reconnect logs the same `force_respawn` line with `reason: "socket_close"`.
