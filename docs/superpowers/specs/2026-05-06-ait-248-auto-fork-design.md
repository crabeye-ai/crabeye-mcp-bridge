# AIT-248 — Auto-fork on server→client requests + sharing config

**Status:** spec  
**Epic:** AIT-244 phase D  
**Blocks:** AIT-249  
**Blocked by:** AIT-247

## Problem

Default-shared upstream children are safe for fan-out-routable server→client traffic
(`progress`, `cancelled`, `*/list_changed`, `resources/updated`, `logging/message`).
They break for server→client *requests* that expect a per-client response —
`sampling/createMessage`, `elicitation/create`, `roots/list`, or any unknown method.
A shared child has no way to know which session's bridge should answer such a request,
and answers from multiple bridges would be incoherent.

Phase D detects these server→client requests, isolates each attached session onto its own
dedicated child without observable disruption, and exposes a `_bridge.sharing` config
to let users opt out of auto-sharing entirely.

## Goal

Default-shared remains safe even when an upstream surprises us with a server→client
request method that doesn't fit fan-out routing. Migration is clean: sessions resume
without observable disruption beyond the request that triggered the fork.

## Non-goals

- `RESTART` admin command (deferred to AIT-249, phase E).
- Force-respawn on liveness failure (deferred to AIT-249).
- Daemon-side reconnect/respawn — bridge-side `_scheduleReconnect` in
  `BaseUpstreamClient` already handles this with exponential backoff.

## Design

### Sharing modes

Per-upstream `_bridge.sharing` config: `"auto" | "shared" | "dedicated"`. Default
`"auto"`.

| mode | initial spawn | shareable with peers? | server→client request response |
|------|---------------|------------------------|----------------------------|
| `auto` | dedupe by hash | yes, with other `auto` sessions on same hash | trigger fork; taint hash |
| `shared` | dedupe by hash | yes, with other `shared` sessions on same hash | reply `-32601 Method not found` to child; warn; never fork |
| `dedicated` | fresh child per session | never (refcount cap 1 from spawn) | n/a |

### Group registry

Replaces today's `groups: Map<upstreamHash, ChildGroup>` with three coordinated
pieces of state:

1. **`groups: Map<groupId, ChildGroup>`** — every live group, keyed by an opaque
   per-group id (`${hash}:${sharing}:${counter}`). Source of truth for STATUS,
   inbound routing lookup, kill/cleanup.
2. **`shareableIndex: Map<string, ChildGroup>`** — currently shareable group
   per `${hash}:${sharing}` pair. `dedicated` entries never appear here. An
   `auto` entry is removed when it forks.
3. **`autoTainted: Set<hash>`** — hashes where `auto` mode has triggered a
   fork. Future `auto` OPENs for these hashes are forced to spawn fresh
   dedicated children.

OPEN attach logic:

```
if sharing === "dedicated":
  spawn fresh, mode=dedicated, refcount cap 1
  register in `groups` only

else if sharing === "auto" && autoTainted.has(hash):
  spawn fresh, mode=dedicated, refcount cap 1
  register in `groups` only

else:
  existing = shareableIndex.get(`${hash}:${sharing}`)
  if existing && !existing.dying:
    attach; refcount += 1
  else:
    spawn fresh, mode=shared
    register in `groups` AND shareableIndex
```

`ChildGroup` gains:

- `mode: "shared" | "dedicated"` — runtime state. Starts mirroring sharing
  config (auto/shared → `"shared"`, dedicated → `"dedicated"`). Flips
  `shared → dedicated` for the originating session's old group on fork.
- `sharing: "auto" | "shared" | "dedicated"` — config intent at OPEN time
  (immutable). Used in shareable-index keying.
- `forked: boolean` — true once this group has triggered an auto-fork.
  Cosmetic for STATUS; routing decisions use `mode` and `autoTainted`.

### OPEN payload extension

`OpenParams.spec` extended:

```ts
spec: {
  serverName: string;
  command: string;
  args: string[];
  resolvedEnv: Record<string, string>;
  cwd: string;
  // NEW in Phase D:
  sharing: "auto" | "shared" | "dedicated";
  clientInfo: { name: string; version: string };
  clientCapabilities: Record<string, unknown>;
  protocolVersion: string;
}
```

`parseOpenParams` validates: `sharing` enum membership, `clientInfo.{name,version}`
strings under existing byte caps, `clientCapabilities` JSON object under a fresh
`MAX_CLIENT_CAPS_BYTES = 64 * 1024`, `protocolVersion` string under 64 bytes.

`SessionAttachment` stores them per-session for replay use. Bridge collects
the values from its `BaseUpstreamClient` neighbours: `clientInfo` from
`{name: ${APP_NAME}/${this.name}, version: APP_VERSION}`, `clientCapabilities`
from the SDK `Client` config, `protocolVersion` from the SDK's exported
`LATEST_PROTOCOL_VERSION`, `sharing` from `_config._bridge.sharing` (defaults
to `"auto"`).

### Detection

`manager.ts::routeChildMessage` already classifies child→bridge payloads via
`TokenRewriter.inboundFromChild`. Today the `kind: "other"` branch hands off
to `NotificationRouter`. New pre-router check: if payload is a *request*
(has `method` + `id`), hand it to `AutoForkOrchestrator` — *every* server→client
request is treated as a server→client request requiring per-session routing in `auto` mode, not just the named ones.
There is no per-request safe-set (unlike notifications, which `NotificationRouter`
fan-out-routes by method). Server→client *notifications* keep going through
`NotificationRouter` unchanged. `progress`/`cancelled` are intercepted earlier
by `TokenRewriter` and never hit this branch.

```ts
if (routing.kind === "other") {
  const p = routing.payload as { id?: unknown; method?: unknown };
  const isRequest = (typeof p.id === "string" || typeof p.id === "number")
                  && typeof p.method === "string";
  if (isRequest) {
    void this.autoFork.handleServerRequest(group, routing.payload);
    return;
  }
  // notification — fan out as before
  const sessions = group.router.route(...);
  ...
}
```

### Auto-fork orchestrator

New module `src/daemon/auto-fork.ts`. Owns: server→client request handling,
per-session migration state, daemon-issued `initialize`/`subscribe` replay,
drain timeout + outbound queue, originating-session forwarding.

Per-session migration state lives on `SessionAttachment`:

```ts
type MigrationState =
  | { kind: "idle" }
  | { kind: "draining"; newGroup: ChildGroup; queuedOutbound: unknown[];
      drainDeadline: number }
  | { kind: "migrated" };
```

#### `handleServerRequest(group, payload)`

Behavior depends on group's `sharing` config:

- `shared`: synthesize JSON-RPC `-32601 Method not found` response, write to
  child's stdin; log warning once per (group, method); return.
- `dedicated`: forward request to the (single) attached session's bridge via
  existing RPC notification path; no fork; return.
- `auto`: fork.

Fork sequence:

1. **Pick originating session.** First-attached session by insertion order.
   Server didn't address one (request is from the shared child); first-attached
   is the deterministic, cheap choice.
2. **Taint the hash and de-list the group.** `autoTainted.add(hash)`,
   `shareableIndex.delete(${hash}:auto)`.
3. **Flip old group state.** `mode: "shared" → "dedicated"`, `forked = true`.
4. **For each non-originating session, transition `idle → draining`:**
   - Spawn fresh dedicated child via `manager.spawnGroup(hash, spec, mode="dedicated")`.
   - Initialize `queuedOutbound = []`, `drainDeadline = now + autoForkDrainTimeoutMs`.
   - Arm per-session drain timer.
5. **Forward triggering request to originating session's bridge** via the
   existing `deliver(group, [originatingSessionId], payload)` path. Old child
   stays alive long enough to deliver the bridge's response back (refcount=1
   so no idle-grace expiry yet). Triggering request's response routes through
   normal token-rewriter machinery — no special path needed.
6. **In parallel, run replay sequence per non-originating session:**
   - Daemon-issued `initialize` against new child with stored
     `{ protocolVersion, clientInfo, capabilities: clientCapabilities }`.
     Internal-id `-1`. Timeout: `autoForkInitializeTimeoutMs` (default 10s).
   - On error or timeout: emit `SESSION_EVICTED` notification with reason
     `auto_fork_initialize_failed`, kill new child, force-detach session via
     existing `detachSession` path. Bridge's transport observes `onclose`,
     `_scheduleReconnect` kicks in.
   - On success: store result in new group's `child.cachedInit` (matches
     existing shape), write `notifications/initialized` notification.
   - Daemon-issued `resources/subscribe` for each URI in the *old group's*
     subscription tracker that this session subscribed to. Internal-ids
     `-2, -3, ...`. Sequential per session. Per-URI errors logged and skipped;
     don't fail whole migration.
   - On replay completion: register subscriptions in new group's tracker.
7. **Wait for old-child inflight to drain for this session.** Hooked via
   `routeChildMessage` callback on every `kind: "response"` delivery —
   orchestrator checks if old group's `rewriter.inflightForSession(sessionId)`
   has hit zero. Draining sessions need both replay-done AND inflight-zero
   before transitioning to `migrated`.
8. **Transition to `migrated`:**
   - `rewriter.attachSession(sessionId)` on new group.
   - Move session in `groups`/`sessions` maps from old to new.
   - Flush `queuedOutbound` to new child via the standard `outboundForChild`
     + `child.send` path (in arrival order).
   - Old group's `subscriptions.removeSession(sessionId)` emits
     `resources/unsubscribe` to old child for URIs whose refcount hits zero.
   - Old group's `rewriter.detachSession(sessionId)` cleans token-rewriter state
     for the migrated session.

Originating session is never in `draining` — it stays attached to the old group
in `idle` state; its `mode` is now `dedicated` because the group's `mode`
flipped.

#### Outbound path during drain

Existing `handleNotification` path checks the new `migration` field before
forwarding to old child:

```
if (attachment.migration.kind === "draining") {
  if (queuedOutbound.length >= MAX_QUEUE_PER_SESSION (256)) {
    sendInnerError(channel, sessionId, innerId,
                   INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE,
                   "session migration buffer full");
    return;
  }
  queuedOutbound.push(payload);
  return;
}
// idle / migrated — existing path unchanged
```

`MAX_QUEUE_PER_SESSION = 256` (configurable via `ManagerOptions`).

#### Drain timeout

60s default (`autoForkDrainTimeoutMs`), configurable. On expiry:

1. If init+subscribe replay finished, force-flush queued outbound to new child,
   transition to `migrated`. Synthesize
   `INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT` for any still-pending old-child
   inflight requests for this session.
2. If init+subscribe replay didn't finish, kill new child, emit
   `SESSION_EVICTED` with reason `auto_fork_drain_timeout`, force-detach session.
   Bridge reconnects.

`autoForkDrainTimeoutMs = 0` disables (waits forever) — useful for tests.

#### Bridge-side eviction handling

New daemon→bridge notification method `SESSION_EVICTED`:

```ts
export interface SessionEvictedParams {
  sessionId: string;
  reason: "auto_fork_initialize_failed" | "auto_fork_drain_timeout";
}
```

`DaemonStdioTransport._onNotification` adds a branch: if method is
`SESSION_EVICTED` and `params.sessionId === this._daemonSessionId`, fire
`onclose` (and optionally `onerror` with the reason). This drives the existing
`BaseUpstreamClient._scheduleReconnect` path — exponential backoff (1s base,
doubling, 30s cap, 5 attempts default), then a fresh OPEN spawns a new
daemon-side child.

Targeted to the affected session; doesn't disturb peers on the same channel.

### Internal request id allocator

`AutoForkOrchestrator`'s daemon-issued `initialize` and `resources/subscribe`
requests use *negative* integer ids (`-1, -2, …`) per-child. `TokenRewriter.inboundFromChild`
short-circuits when `id` is a negative number: returns
`{ kind: "internal", id, payload }`. Manager dispatches to a per-child
`internalRequestRegistry: Map<number, (payload) => void>` owned by the
orchestrator; orchestrator resolves the corresponding promise.

This keeps daemon-issued requests in a separate id namespace from session
outerIds (which are positive), avoiding collision.

### Edge cases

| Case | Handling |
|------|----------|
| Old child dies mid-fork | Existing `handleChildExit` emits `INNER_ERROR_CODE_SESSION_CLOSED` for inflight on old child. Orchestrator: for sessions still in `draining`, treat inflight as terminated, proceed with replay if not yet done, then transition to `migrated`. |
| New child dies mid-replay | Internal-id promise rejects → take `auto_fork_initialize_failed` path: SESSION_EVICTED, force-detach. Other sessions' replays unaffected (they have separate new children). |
| Bridge channel drops during drain | Existing `channel.on("close")` handler iterates owned sessions and calls `detachSession`. New step inside `detachSession`, before existing teardown: if `attachment.migration.kind === "draining"`, the orchestrator kills the not-yet-attached new child, clears `queuedOutbound`, cancels the drain timer, then control returns to the existing detach flow which handles the old-group state. |
| Second server→client request from old child during drain | `autoTainted` already set, group's `mode` already `dedicated`, fork won't re-fire. Forward to originating session's bridge (group has only originating session left). |
| `shared` mode + server→client request | Detection branch synthesizes `-32601` to child via `child.send`. Logged once per (group, method). |
| Dangerous request before any session attached | Impossible — child only spawns on OPEN. |

## Wire-protocol additions

### New error codes (`src/daemon/protocol.ts`)

```ts
// Daemon-protocol-level
export const ERROR_CODE_AUTO_FORK_INITIALIZE_FAILED = "auto_fork_initialize_failed";

// Synthetic JSON-RPC error codes (returned to bridge inside RPC notifications)
export const INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT = -32002;
export const INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE = -32003;
```

### New notification method

```ts
export type DaemonMethod = ... | "SESSION_EVICTED";

export interface SessionEvictedParams {
  sessionId: string;
  reason: "auto_fork_initialize_failed" | "auto_fork_drain_timeout";
}
```

### `StatusChild` extension

```ts
export interface StatusChild {
  pid: number;
  upstreamHash: string;
  startedAt: number;
  refcount: number;
  sessions: string[];
  subscriptionCount: number;
  mode: "shared" | "dedicated";              // was: literal "shared"
  sharing: "auto" | "shared" | "dedicated";  // NEW
  forked: boolean;                           // NEW
  cachedInit: { protocolVersion: string } | null;
}
```

### Config schema (`src/config/schema.ts`)

```ts
export const ServerBridgeConfigSchema = z.object({
  ...,
  sharing: z.enum(["auto", "shared", "dedicated"]).default("auto").optional(),
}).strict();

export const DaemonConfigSchema = z.object({
  ...,
  autoForkDrainTimeoutMs: z.number().int().nonnegative().default(60_000),
  autoForkInitializeTimeoutMs: z.number().int().nonnegative().default(10_000),
}).strict();
```

## Files touched

| File | Change |
|------|--------|
| `src/daemon/protocol.ts` | OPEN spec extension; new error codes; SESSION_EVICTED method + params; StatusChild fields |
| `src/daemon/manager.ts` | Group registry refactor (3-piece state); OPEN attach logic; dispatch hook for server→client requests; SessionAttachment carries client identity + migration state; SESSION_EVICTED emission |
| `src/daemon/auto-fork.ts` (new) | `AutoForkOrchestrator`: detection helper, per-session migration state machine, daemon-issued initialize/subscribe replay with internal-id allocator, drain timeout + buffer, queue flushing, originating-session forwarding |
| `src/daemon/token-rewriter.ts` | Inbound classifier returns `kind: "internal"` for negative ids; orchestrator's registered callback consumes |
| `src/upstream/daemon-stdio-client.ts` | Pass `sharing`, `clientInfo`, `clientCapabilities`, `protocolVersion` in OPEN; SESSION_EVICTED handler triggers `transport.onclose` |
| `src/config/schema.ts` | `_bridge.sharing` enum; daemon timeouts |
| `test/daemon/auto-fork.test.ts` (new) | Orchestrator unit tests |
| `test/daemon/sharing-modes.test.ts` (new) | End-to-end auto/shared/dedicated tests |
| `test/daemon/sharing.test.ts` | Update mode-field assertions for the new union |
| `test/daemon/status-output.test.ts` | Assert new StatusChild fields |

## Acceptance criteria

- [ ] Stub MCP server emits `sampling/createMessage` mid-session → daemon forks:
  - [ ] Originating session keeps old child as dedicated; mode flips to `dedicated`; refcount=1.
  - [ ] Each other attached session migrates to a fresh dedicated child.
  - [ ] Daemon-issued `initialize` replayed against each new child with that
        session's `protocolVersion`, `clientInfo`, `capabilities`.
  - [ ] `resources/subscribe` state replayed for each migrated session.
  - [ ] Triggering request reaches originating bridge.
  - [ ] Subsequent `tools/call` from non-originating session works without re-OPEN.
- [ ] Stub server emits unknown method `foo/bar` (request) → fork behavior identical.
- [ ] Stub server emits `roots/list` and `elicitation/create` → fork behavior identical.
- [ ] `_bridge.sharing: "dedicated"` upstream → always 1 child per session,
      never shared, even with identical hash from another bridge.
- [ ] `_bridge.sharing: "shared"` upstream emits server→client request →
      no fork; daemon writes `-32601 Method not found` to child stdin;
      bridge logs warning; sessions undisturbed.
- [ ] Pending non-originating-session outbound during drain queues up to 256
      payloads, then `INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE`.
- [ ] Drain timeout (60s default) elapses with replay incomplete →
      `SESSION_EVICTED` with `auto_fork_drain_timeout`; bridge transport
      observes `onclose`; bridge reconnects via existing exponential backoff.
- [ ] Replay `initialize` failure → `SESSION_EVICTED` with
      `auto_fork_initialize_failed`; bridge reconnects.
- [ ] After fork, STATUS shows N dedicated children (one per session) for the
      upstream — old child entry has `mode: "dedicated"`, `forked: true`,
      `sharing: "auto"`; new child entries have `mode: "dedicated"`,
      `forked: false`, `sharing: "auto"`.
- [ ] Hash taint persists for daemon lifetime: post-fork OPEN with
      `sharing: "auto"` for the same hash spawns fresh dedicated child.

## Test plan

### `auto-fork.test.ts` — orchestrator unit tests (fake child handles)

- Detection: `tools/list_changed` notification doesn't trigger; `sampling/createMessage`,
  `foo/bar`, `roots/list`, `elicitation/create` requests do.
- Replay: per-session `initialize` issued with stored caps + protocolVersion + clientInfo;
  `notifications/initialized` follows; each tracked URI gets a `resources/subscribe`.
- State machine: `idle → draining → migrated`; queued outbound flushes in arrival order;
  old-child inflight count drops to zero advances drain.
- Drain timeout: synthetic timeout → `INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT`
  for stuck inflight; `SESSION_EVICTED` if replay also stuck.
- Drain backpressure: 257th queued payload returns `INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE`.
- Originating session keeps old child; mode flips `shared → dedicated`;
  subscription tracker shrinks to originating session's URIs only.
- Hash taint: post-fork OPEN with `sharing: "auto"` for same hash → fresh
  dedicated child, refcount cap 1, not shared with the originating session's
  group.

### `sharing-modes.test.ts` — integration with real ChildHandle

- `auto` + server→client request → fork end-to-end; subsequent `tools/call`
  works without re-OPEN; STATUS reflects per-session children.
- `shared` + server→client request → daemon emits `-32601` to child; sessions
  unaffected; warning logged once.
- Two `dedicated` OPENs (same hash, different bridges) → two children,
  refcount=1 each.
- `dedicated` (bridge A) + `auto` (bridge B), same hash → two children;
  A is dedicated, B is auto-shared.

### Existing test updates

- `sharing.test.ts`: mode field assertion → handle the union.
- `status-output.test.ts`: assert new fields (`sharing`, `forked`).

### Stub MCP server

Reuse the pattern from `e2e-two-bridge.test.ts`. Add a stub that emits
`sampling/createMessage` (and other server→client request methods) on demand, triggered
by a special tool call from the bridge.

## Open questions

None at spec time.

## References

- AIT-244 epic
- AIT-247 (phase C, blocking dependency): hash-based sharing + notification fan-out
- AIT-249 (phase E): RESTART + force-respawn (this spec's blocked-by relation)
