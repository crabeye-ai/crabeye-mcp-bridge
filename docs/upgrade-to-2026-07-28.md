# Upgrading to crabeye-mcp-bridge 2.0 (MCP 2026-07-28)

crabeye-mcp-bridge 2.0 supports the MCP 2026-07-28 protocol. AI clients and upstream servers that still use an earlier protocol keep working until 2027-07-28, the end of the spec's deprecation period. This page covers what changes when you upgrade from 1.x, and what changes again in 3.0.

## After upgrading

**Restart every AI client.** Bridges and managers from before 2.0 can't work with each other. A 2.0 bridge replaces an older manager when it starts, and a bridge still running from before the upgrade gets an error telling you to restart its AI client; on Windows it reports that it can't reach the manager instead. Also on Windows, the first AI client started after upgrading can take up to a minute to connect while the older manager stops.

Your config files need no changes. Settings that no longer do anything (`--discovery-mode`, `_bridge.sharing`, `_bridge.daemon.autoFork*`) are still accepted, and each logs one warning saying it is ignored.

## Old and new protocols side by side

Until 3.0, the bridge speaks both the 2026-07-28 protocol and the earlier ones, with nothing to configure:

* **Your AI client.** The bridge answers a client on either protocol. Tools that your tool policy marks `"prompt"` are approved through the client's confirmation prompt on either protocol. A client that can't show one gets an error saying so.
* **Upstream servers.** The [manager](stdio-manager.md) finds out which protocol each server speaks and uses it. A STDIO server that ignores the question, as some older servers do, makes its first start take about 10 seconds; the manager remembers the answer until it stops. `crabeye-mcp-bridge daemon status` shows each STDIO server's protocol as `modern`, `legacy` or `unknown`.
* **SSE upstreams.** `"type": "sse"` keeps working, with a deprecation warning. Prefer `"streamable-http"` if your server offers it.

## What changes in 2.0

### Only `search_tools` and `run_tool`

The bridge always lists exactly two tools, `search_tools` and `run_tool`. Searching no longer adds the tools it finds to the assistant's tool list. The end of the `search_tools` description lists the servers and their status, and the bridge tells the assistant when that list changes (see [Servers and their status](how-it-works.md#servers-and-their-status)). Each result includes the tool's full input schema, and tools from servers that connect later are still found by search.

* Upstream tools run only through `run_tool`. Calling one by its own name, such as `linear__create_issue`, fails as an unknown tool, and nothing is sent to the server.
* Your AI client sees only the two bridge tools, so permission rules it keeps per tool can't tell upstream tools apart. Use [tool policies](policies.md) (`"prompt"`, `"never"`) to control individual tools.
* `--discovery-mode` has no effect.
* Servers with `_bridge.passthrough` on no longer have their instructions added to the bridge's instructions; a search returns them when the assistant asks (see [Context passthrough](configuration.md#context-passthrough)).
* `_bridge.passthrough` is now `true` or `false`. The old `"instructions"`, `"tools"` and `"full"` values still load and mean `true`; `"tools"` and `"full"` also log a warning, because a search already returns a server's tools.

### Servers can't ask your AI client for input

Requests from an upstream server to your AI client, such as elicitation, sampling or roots, are no longer passed on. A tool call during which the server asks for client input fails with an error naming the server and saying crabeye-mcp-bridge doesn't support that request. The server keeps serving every other client. The bridge's own approval prompts for `"prompt"` tools are not affected.

Because of this, every bridge using the same STDIO server shares one server process through the manager. `_bridge.sharing` and the `_bridge.daemon.autoFork*` settings no longer have any effect.

### Server log messages stay in the server

Log messages that upstream servers send through the protocol are no longer passed on. What a STDIO server writes to stderr shows in the log of every bridge using it at debug level (set `_bridge.logLevel` to `"debug"` to see it). When a STDIO server fails to start, exits or stops answering, each bridge using it logs a warning with the server's last stderr lines.

### Failures are tool results

A tool call that fails, for example because a policy denies it, the server is unavailable or needs authorization again, or the rate-limit queue is full, now returns its message as a tool result the assistant can read instead of as a protocol error. Arguments to `search_tools` and `run_tool` are checked against the tool's input schema, and arguments that don't match get a result saying what's wrong.

### The manager does the work for every client

The manager now connects every upstream, STDIO and HTTP, once for all your AI clients. It also runs search, rate limits, tool policy and OAuth token refreshes for all of them, and follows config edits:

* a server gets one connection, and an OAuth token is refreshed once, however many clients are open;
* a server's rate limit is one budget shared by every client whose config gives it the same limit;
* edits to your MCP config files and to `~/.crabeye-mcp-bridge/config.json` apply to every client without a restart, except for the settings listed in [What happens when I edit my MCP config and save?](stdio-manager.md#what-happens-when-i-edit-my-mcp-config-and-save).

## What changes in 3.0 (planned, from 2027-07-28)

When the deprecation period ends, 3.0 will drop what 2.0 still supports:

* **AI clients on protocols earlier than 2026-07-28 will be refused.** Before upgrading to 3.0, update every AI client to a release that speaks 2026-07-28.
* **`"type": "sse"` will be removed.** A config with an SSE upstream will fail at start with an error naming the server. Switch those servers to `"streamable-http"` now if they offer it.

Until then, nothing you do on 2.0 needs to change for 3.0 except these two.
