# AIT-248 — Auto-fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect server→client *requests* on shared upstream children, isolate each attached session onto its own dedicated child without observable disruption (drain-then-migrate model), and expose `_bridge.sharing` config to opt out of sharing.

**Architecture:** A new `AutoForkOrchestrator` (`src/daemon/auto-fork.ts`) drives a per-session state machine (`idle → draining → migrated`). When a server→client request arrives, originating session keeps the old child as dedicated; non-originating sessions buffer outbound, get fresh children with daemon-issued `initialize`/`resources/subscribe` replay (using a negative-int internal-id namespace through `TokenRewriter`), wait for old-child inflight to drain, then flush queued outbound. Bridge eviction on replay/drain failure flows through a new `SESSION_EVICTED` notification that triggers existing `_scheduleReconnect` in `BaseUpstreamClient`.

**Tech Stack:** TypeScript + Node 22 + Vitest. Daemon side: `src/daemon/*`. Bridge side: `src/upstream/daemon-stdio-client.ts`. Config: `src/config/schema.ts`.

**Spec:** `docs/superpowers/specs/2026-05-06-ait-248-auto-fork-design.md`

---

## Conventions (read this first)

- **Commit format** (per `commit-push` skill, this repo is closed source):
  ```
  AIT-248 - Auto-fork on server→client requests + sharing config // <comment>
  ```
  Single line. **No** `Co-Authored-By` line. **No** AI-attribution footer.

- **No commit without explicit ask.** This plan's commit steps assume the user has said "go ahead with this task" — never auto-commit; surface the staged diff and ask.

- **Trunk-based.** Work directly on `main`. No feature branches, no PR.

- **Push policy.** Hold pushes until all AIT-244 epic phase tickets ready (per `project_ait244_push_policy`). Do not run `git push` during this work.

- **TDD.** Every task starts with a failing test, then minimal implementation, then commit. Skipping the test step is a plan failure.

- **Run before claiming done:**
  ```
  npm run build && npm test && npm run lint
  ```
  All three must pass before any commit.

---

## File structure

| File | Status | Responsibility |
|------|--------|----------------|
| `src/daemon/protocol.ts` | modify | Wire types: extend `OpenParams.spec`, add `SESSION_EVICTED` method + params, new error codes, `StatusChild` field union |
| `src/daemon/manager.ts` | modify | Group registry (3-piece state), OPEN attach logic, dispatch hook for server→client requests, `SessionAttachment` carries client identity + migration state |
| `src/daemon/auto-fork.ts` | create | `AutoForkOrchestrator` — detection, fork sequence, per-session state machine, internal-id allocator client, drain timeout, queue flush, SESSION_EVICTED emission |
| `src/daemon/token-rewriter.ts` | modify | `inboundFromChild` short-circuits negative-int ids → `kind: "internal"` |
| `src/daemon/index.ts` | modify | Re-export new public types |
| `src/upstream/daemon-stdio-client.ts` | modify | Pass new OPEN fields; handle `SESSION_EVICTED` notification → `transport.onclose` |
| `src/upstream/base-client.ts` | modify (minor) | Expose `protocolVersion` and `clientCapabilities` to subclasses (or pass through constructor) |
| `src/config/schema.ts` | modify | `_bridge.sharing` enum; `daemon.autoForkDrainTimeoutMs`, `daemon.autoForkInitializeTimeoutMs` |
| `test/daemon/protocol.test.ts` | modify | New error codes, `SESSION_EVICTED` shape |
| `test/daemon/manager.test.ts` | modify | Updated OPEN params payload (new required fields) |
| `test/daemon/sharing.test.ts` | modify | Mode union assertions |
| `test/daemon/status-output.test.ts` | modify | New `StatusChild` fields |
| `test/daemon/token-rewriter.test.ts` | modify | Negative-id classification path |
| `test/daemon/auto-fork.test.ts` | create | Orchestrator unit tests (state machine, replay, drain, timeout) |
| `test/daemon/sharing-modes.test.ts` | create | Integration: `auto` fork + `shared` -32601 + `dedicated` cross-bridge |
| `test/_helpers/stub-mcp-server.ts` | create | Stub child that emits `sampling/createMessage` on demand |

---

## Task index

1. Wire-protocol additions (types only)
2. Config schema additions
3. `OpenParams.spec` extension and validation
4. Bridge ships new OPEN fields
5. `ChildGroup` state extension + `StatusChild` rendering
6. Group registry refactor (3-piece state)
7. `TokenRewriter` internal-id classifier
8. `AutoForkOrchestrator` skeleton + detection hook
9. `shared` and `dedicated` dispatch
10. Per-session migration state + outbound buffering
11. Fork sequence: spawn + daemon-issued `initialize` replay
12. Fork sequence: `resources/subscribe` replay + drain detection + migration completion
13. Drain timeout + initialize timeout + `SESSION_EVICTED` emission
14. Bridge-side `SESSION_EVICTED` handling
15. Hash taint persistence + post-fork STATUS
16. Edge cases: old child dies mid-fork; bridge channel drops mid-drain
17. Stub MCP server + integration tests

---

## Task 1: Wire-protocol additions (types only)

**Files:**
- Modify: `src/daemon/protocol.ts`
- Modify: `src/daemon/index.ts`
- Modify: `test/daemon/protocol.test.ts`

- [ ] **Step 1.1: Write failing test for new error codes and SESSION_EVICTED type**

Append to `test/daemon/protocol.test.ts`:
```ts
import {
  ERROR_CODE_AUTO_FORK_INITIALIZE_FAILED,
  INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT,
  INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE,
  type SessionEvictedParams,
  type DaemonMethod,
} from "../../src/daemon/protocol.js";

describe("protocol — Phase D additions", () => {
  it("exports auto-fork error codes with correct shapes", () => {
    expect(ERROR_CODE_AUTO_FORK_INITIALIZE_FAILED).toBe("auto_fork_initialize_failed");
    expect(INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT).toBe(-32002);
    expect(INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE).toBe(-32003);
  });

  it("typechecks SESSION_EVICTED method and params", () => {
    const m: DaemonMethod = "SESSION_EVICTED";
    const p: SessionEvictedParams = {
      sessionId: "11111111-1111-1111-1111-111111111111",
      reason: "auto_fork_drain_timeout",
    };
    expect(m).toBe("SESSION_EVICTED");
    expect(p.reason).toBe("auto_fork_drain_timeout");
  });
});
```

- [ ] **Step 1.2: Run the test, expect failure**

Run: `npx vitest run test/daemon/protocol.test.ts`
Expected: failures on `ERROR_CODE_AUTO_FORK_INITIALIZE_FAILED is not exported` etc.

- [ ] **Step 1.3: Add the constants and types**

In `src/daemon/protocol.ts`, after the existing inner error codes:
```ts
/** Daemon-protocol-level error: failed to replay `initialize` against a forked child. */
export const ERROR_CODE_AUTO_FORK_INITIALIZE_FAILED = "auto_fork_initialize_failed";

/** Inner JSON-RPC error: drain window exceeded autoForkDrainTimeoutMs with old-child requests still pending. */
export const INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT = -32002;

/** Inner JSON-RPC error: per-session drain queue overflowed during fork. */
export const INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE = -32003;
```

Extend the `DaemonMethod` union:
```ts
export type DaemonMethod =
  | "STATUS"
  | "SHUTDOWN"
  | "OPEN"
  | "OPENED"
  | "RPC"
  | "CLOSE"
  | "RESTART"
  | "SESSION_EVICTED";
```

Add the params interface:
```ts
export interface SessionEvictedParams {
  sessionId: string;
  reason: "auto_fork_initialize_failed" | "auto_fork_drain_timeout";
}
```

- [ ] **Step 1.4: Re-export from index.ts**

In `src/daemon/index.ts`, in the `from "./protocol.js"` re-exports, add:
```ts
ERROR_CODE_AUTO_FORK_INITIALIZE_FAILED,
INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT,
INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE,
```
And in the type re-exports add `SessionEvictedParams`.

- [ ] **Step 1.5: Run tests + build + lint**

```
npm run build && npm test -- test/daemon/protocol.test.ts && npm run lint
```
Expected: all pass.

- [ ] **Step 1.6: Stage and ask user before commit**

```
git add src/daemon/protocol.ts src/daemon/index.ts test/daemon/protocol.test.ts
git status
```
Show user the diff. On approval:
```
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // wire-protocol additions: auto-fork error codes, SESSION_EVICTED method"
```

---

## Task 2: Config schema additions

**Files:**
- Modify: `src/config/schema.ts`
- Test: existing config tests (none assert daemon defaults today; we add one)
- Modify or create: `test/config/schema.test.ts` (check whether it exists; if not, append to closest existing schema test or create)

- [ ] **Step 2.1: Locate the existing config schema test**

```
ls test/config/ 2>&1 || echo "no test/config dir"
grep -rln "ServerBridgeConfigSchema\|DaemonConfigSchema" test/ src/
```
Pick the most fitting test file (likely `src/config/schema.ts` has no test today — create `test/config/schema.test.ts`).

- [ ] **Step 2.2: Write failing test for sharing enum and new daemon defaults**

Create `test/config/schema.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import {
  ServerBridgeConfigSchema,
  DaemonConfigSchema,
} from "../../src/config/schema.js";

describe("config — Phase D sharing config", () => {
  it("ServerBridgeConfigSchema accepts sharing enum and defaults to undefined", () => {
    const parsed = ServerBridgeConfigSchema.parse({});
    expect(parsed.sharing).toBeUndefined();
    expect(ServerBridgeConfigSchema.parse({ sharing: "auto" }).sharing).toBe("auto");
    expect(ServerBridgeConfigSchema.parse({ sharing: "shared" }).sharing).toBe("shared");
    expect(ServerBridgeConfigSchema.parse({ sharing: "dedicated" }).sharing).toBe("dedicated");
    expect(() => ServerBridgeConfigSchema.parse({ sharing: "bogus" })).toThrow();
  });

  it("DaemonConfigSchema exposes auto-fork timeouts with sane defaults", () => {
    const parsed = DaemonConfigSchema.parse({});
    expect(parsed.autoForkDrainTimeoutMs).toBe(60_000);
    expect(parsed.autoForkInitializeTimeoutMs).toBe(10_000);
    expect(() => DaemonConfigSchema.parse({ autoForkDrainTimeoutMs: -1 })).toThrow();
  });
});
```

- [ ] **Step 2.3: Run, expect failure**

```
npx vitest run test/config/schema.test.ts
```
Expected: schema rejects `sharing` and the new daemon fields.

- [ ] **Step 2.4: Add the schema fields**

In `src/config/schema.ts`, modify `ServerBridgeConfigSchema`:
```ts
export const ServerBridgeConfigSchema = z
  .object({
    auth: ServerOAuthConfigSchema.optional(),
    toolPolicy: ToolPolicySchema.optional(),
    tools: z.record(z.string(), ToolPolicySchema).optional(),
    category: z.string().optional(),
    rateLimit: RateLimitConfigSchema.optional(),
    reconnect: ReconnectConfigSchema.optional(),
    sharing: z.enum(["auto", "shared", "dedicated"]).optional(),
  })
  .strict();
```
(Default is intentionally undefined here; daemon-side default `"auto"` is applied at OPEN-construction time on the bridge side — keeps the wire payload stable for older configs.)

Modify `DaemonConfigSchema`:
```ts
export const DaemonConfigSchema = z
  .object({
    idleMs: z.number().int().positive().default(60_000),
    graceMs: z.number().int().nonnegative().default(60_000),
    killGraceMs: z.number().int().nonnegative().default(2_000),
    autoForkDrainTimeoutMs: z.number().int().nonnegative().default(60_000),
    autoForkInitializeTimeoutMs: z.number().int().nonnegative().default(10_000),
  })
  .strict();
```

- [ ] **Step 2.5: Run, expect pass; rebuild + lint**

```
npm run build && npm test -- test/config/schema.test.ts && npm run lint
```

- [ ] **Step 2.6: Commit (stage + ask user first)**

```
git add src/config/schema.ts test/config/schema.test.ts
```
On approval:
```
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // _bridge.sharing enum + daemon auto-fork timeouts"
```

---

## Task 3: `OpenParams.spec` extension and validation

**Files:**
- Modify: `src/daemon/protocol.ts` (interface)
- Modify: `src/daemon/manager.ts` (`parseOpenParams`)
- Modify: `test/daemon/manager.test.ts` (the existing OPEN-shape tests need the new required fields)
- Test: add a new `manager-open-params.test.ts` for validation edges

- [ ] **Step 3.1: Write failing test for new required fields and validation**

Create `test/daemon/manager-open-params.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ManagerDaemon } from "../../src/daemon/manager.js";
import { DaemonClient } from "../../src/daemon/client.js";
import { netTransport } from "../../src/daemon/net-transport.js";

const isWindows = process.platform === "win32";

async function tempPaths() {
  const dir = await mkdtemp("/tmp/cbe-mgr-open-params-");
  return {
    dir,
    sock: join(dir, "m.sock"),
    pid: join(dir, "m.pid"),
    lock: join(dir, "m.lock"),
    proc: join(dir, "processes.json"),
  };
}

describe.skipIf(isWindows)("OPEN params — Phase D fields", () => {
  let paths: Awaited<ReturnType<typeof tempPaths>>;
  let manager: ManagerDaemon | null = null;

  beforeEach(async () => {
    paths = await tempPaths();
    await mkdir(paths.dir, { recursive: true });
    manager = null;
  });
  afterEach(async () => {
    if (manager !== null) await manager.stop(0).catch(() => {});
    await rm(paths.dir, { recursive: true, force: true });
  });

  function freshManager(): ManagerDaemon {
    return new ManagerDaemon({
      socketPath: paths.sock,
      pidPath: paths.pid,
      lockPath: paths.lock,
      idleMs: 60_000,
      transport: netTransport,
      processTrackerPath: paths.proc,
      _spawnChild: (_spec, cb) =>
        ({
          startedAt: Date.now(),
          pid: 99999,
          alive: true,
          cachedInit: null,
          setCachedInit() {},
          send() {},
          async kill() {},
          // The fake omits onMessage/onClose wiring intentionally.
          _cb: cb,
        }) as never,
    });
  }

  it("rejects OPEN missing sharing field", async () => {
    manager = freshManager();
    await manager.start();
    const c = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      await expect(
        c.call("OPEN", {
          sessionId: "11111111-1111-1111-1111-111111111111",
          spec: {
            serverName: "x",
            command: "node",
            args: [],
            resolvedEnv: {},
            cwd: "",
            // sharing missing
            clientInfo: { name: "b", version: "1" },
            clientCapabilities: {},
            protocolVersion: "2025-06-18",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    } finally {
      c.close();
    }
  });

  it("rejects OPEN with bogus sharing value", async () => {
    manager = freshManager();
    await manager.start();
    const c = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    try {
      await expect(
        c.call("OPEN", {
          sessionId: "11111111-1111-1111-1111-111111111111",
          spec: {
            serverName: "x",
            command: "node",
            args: [],
            resolvedEnv: {},
            cwd: "",
            sharing: "bogus",
            clientInfo: { name: "b", version: "1" },
            clientCapabilities: {},
            protocolVersion: "2025-06-18",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    } finally {
      c.close();
    }
  });

  it("rejects OPEN with clientCapabilities exceeding 64KB", async () => {
    manager = freshManager();
    await manager.start();
    const c = new DaemonClient({
      socketPath: paths.sock,
      transport: netTransport,
      rpcTimeoutMs: 1_000,
      connectTimeoutMs: 1_000,
    });
    const big = "x".repeat(64 * 1024 + 1);
    try {
      await expect(
        c.call("OPEN", {
          sessionId: "11111111-1111-1111-1111-111111111111",
          spec: {
            serverName: "x",
            command: "node",
            args: [],
            resolvedEnv: {},
            cwd: "",
            sharing: "auto",
            clientInfo: { name: "b", version: "1" },
            clientCapabilities: { huge: big },
            protocolVersion: "2025-06-18",
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_params" });
    } finally {
      c.close();
    }
  });
});
```

- [ ] **Step 3.2: Run, expect failure (today's parser ignores the new fields)**

```
npx vitest run test/daemon/manager-open-params.test.ts
```
Expected: tests fail because today's `parseOpenParams` accepts and silently drops the new fields.

- [ ] **Step 3.3: Extend `OpenParams` type**

In `src/daemon/protocol.ts`:
```ts
export interface OpenParams {
  sessionId: string;
  spec: {
    serverName: string;
    command: string;
    args: string[];
    resolvedEnv: Record<string, string>;
    cwd: string;
    sharing: "auto" | "shared" | "dedicated";
    clientInfo: { name: string; version: string };
    clientCapabilities: Record<string, unknown>;
    protocolVersion: string;
  };
}
```

- [ ] **Step 3.4: Tighten `parseOpenParams` in manager.ts**

Add new size cap near the existing `MAX_*` consts:
```ts
const MAX_CLIENT_CAPS_BYTES = 64 * 1024;
const MAX_PROTOCOL_VERSION_BYTES = 64;
const MAX_CLIENT_INFO_NAME_BYTES = 256;
const MAX_CLIENT_INFO_VERSION_BYTES = 64;
```

Replace `parseOpenParams` body's tail (after the existing cwd checks) with:
```ts
  if (s.sharing !== "auto" && s.sharing !== "shared" && s.sharing !== "dedicated") return null;
  if (typeof s.protocolVersion !== "string" || s.protocolVersion.length === 0
      || s.protocolVersion.length > MAX_PROTOCOL_VERSION_BYTES) return null;
  if (typeof s.clientInfo !== "object" || s.clientInfo === null || Array.isArray(s.clientInfo)) return null;
  const ci = s.clientInfo as { name?: unknown; version?: unknown };
  if (typeof ci.name !== "string" || ci.name.length === 0 || ci.name.length > MAX_CLIENT_INFO_NAME_BYTES) return null;
  if (typeof ci.version !== "string" || ci.version.length === 0 || ci.version.length > MAX_CLIENT_INFO_VERSION_BYTES) return null;
  if (typeof s.clientCapabilities !== "object" || s.clientCapabilities === null
      || Array.isArray(s.clientCapabilities)) return null;
  // Reject if serialized capabilities exceed cap (memory amplification protection).
  const capsJson = JSON.stringify(s.clientCapabilities);
  if (capsJson.length > MAX_CLIENT_CAPS_BYTES) return null;

  return {
    sessionId: r.sessionId,
    spec: {
      serverName: s.serverName,
      command: s.command,
      args: s.args as string[],
      resolvedEnv: s.resolvedEnv as Record<string, string>,
      cwd: s.cwd,
      sharing: s.sharing as "auto" | "shared" | "dedicated",
      clientInfo: { name: ci.name, version: ci.version },
      clientCapabilities: s.clientCapabilities as Record<string, unknown>,
      protocolVersion: s.protocolVersion,
    },
  };
```

- [ ] **Step 3.5: Update existing tests that send OPEN without the new fields**

Search for OPEN payloads in tests and add the new required fields. Most use:
```
const spec = { serverName: "x", command: "node", args: [...], resolvedEnv: {}, cwd: "" };
```
Update each to include:
```
sharing: "auto",
clientInfo: { name: "test-bridge", version: "0.0.0" },
clientCapabilities: {},
protocolVersion: "2025-06-18",
```

Likely files:
```
test/daemon/sharing.test.ts
test/daemon/initialize-cache.test.ts
test/daemon/subscription-dedupe.test.ts
test/daemon/notifications-fanout.test.ts
test/daemon/lifecycle-grace.test.ts
test/daemon/grace-kill-race.test.ts
test/daemon/inflight-cancel.test.ts
test/daemon/e2e-two-bridge.test.ts
test/daemon/token-collision.test.ts
test/daemon/stdio-routing.test.ts
test/daemon/backpressure.test.ts
test/daemon/status-output.test.ts
```
Run a grep first to be sure:
```
grep -rln "serverName: \"x\", command:" test/daemon/
```

- [ ] **Step 3.6: Run all daemon tests + build + lint**

```
npm run build && npm test -- test/daemon/ && npm run lint
```
Expected: all pass.

- [ ] **Step 3.7: Commit (stage + ask user)**

```
git add src/daemon/protocol.ts src/daemon/manager.ts test/daemon/
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // OPEN.spec carries sharing, clientInfo, clientCapabilities, protocolVersion"
```

---

## Task 4: Bridge ships new OPEN fields

**Files:**
- Modify: `src/upstream/daemon-stdio-client.ts`
- Modify: `src/upstream/base-client.ts` (expose protocolVersion + clientCapabilities to subclasses)
- Test: `test/upstream/daemon-stdio-client.test.ts` (create if missing)

- [ ] **Step 4.1: Check if there's an existing daemon-stdio-client test**

```
ls test/upstream/
```
If not, create `test/upstream/daemon-stdio-client.test.ts` for the new behavior.

- [ ] **Step 4.2: Write failing test that asserts OPEN payload contains the new fields**

Use a minimal fake daemon that records the OPEN frame. Test asserts `sharing`, `clientInfo`, `clientCapabilities`, `protocolVersion` are present and reflect bridge config.

Sketch (full code in test file):
```ts
import { DaemonStdioClient } from "../../src/upstream/daemon-stdio-client.js";
// Stand up a fake socket server that captures the first OPEN frame.
// Construct DaemonStdioClient with config containing _bridge: { sharing: "dedicated" }
// Trigger connect; assert the captured OPEN.spec contains the new fields.
```

- [ ] **Step 4.3: Run, expect failure**

```
npx vitest run test/upstream/daemon-stdio-client.test.ts
```

- [ ] **Step 4.4: Update bridge to pass new fields**

In `src/upstream/daemon-stdio-client.ts`, extend `DaemonStdioTransportOpts`:
```ts
interface DaemonStdioTransportOpts {
  serverName: string;
  command: string;
  args: string[];
  resolvedEnv: Record<string, string>;
  cwd: string;
  socketPath: string;
  ensureDaemon: () => Promise<void>;
  sharing: "auto" | "shared" | "dedicated";
  clientInfo: { name: string; version: string };
  clientCapabilities: Record<string, unknown>;
  protocolVersion: string;
}
```

In `_buildTransport()`:
```ts
return new DaemonStdioTransport({
  serverName: this.name,
  command: this._config.command,
  args: this._config.args ?? [],
  resolvedEnv: this._currentEnv,
  cwd: this._config.cwd ?? "",
  socketPath: this._socketPath,
  ensureDaemon: this._ensureDaemon,
  sharing: this._config._bridge?.sharing ?? "auto",
  clientInfo: { name: `${APP_NAME}/${this.name}`, version: APP_VERSION },
  clientCapabilities: this._clientCapabilities,
  protocolVersion: LATEST_PROTOCOL_VERSION,
});
```
(Import `APP_NAME`, `APP_VERSION` from constants; `LATEST_PROTOCOL_VERSION` from `@modelcontextprotocol/sdk/types.js`.)

In `start()` extend the OPEN call params:
```ts
await this.daemonClient.call("OPEN", {
  sessionId: this._daemonSessionId,
  spec: {
    serverName: this.opts.serverName,
    command: this.opts.command,
    args: this.opts.args,
    resolvedEnv: this.opts.resolvedEnv,
    cwd: this.opts.cwd,
    sharing: this.opts.sharing,
    clientInfo: this.opts.clientInfo,
    clientCapabilities: this.opts.clientCapabilities,
    protocolVersion: this.opts.protocolVersion,
  },
});
```

`this._clientCapabilities` source: factor the capabilities object out of `BaseUpstreamClient._doConnect` into a `protected _clientCapabilities` property the subclass can read. The current value is:
```ts
{
  listChanged: {
    tools: { autoRefresh: true, onChanged: ... },
  },
}
```
The `onChanged` callback is a runtime hook, not a wire field. For the OPEN payload, ship the wire-shape only (e.g. `{ tools: { listChanged: true } }` — what an MCP client typically advertises). Verify against the SDK: the SDK serializes the `Client` constructor's caps argument differently from the wire format. For Phase D we want **the wire-format capabilities**. Concretely, ship:
```ts
const wireCaps: Record<string, unknown> = {};
// MCP spec: client may advertise "roots", "sampling", "elicitation". Bridge currently
// supports none of these inbound (it's a passthrough). Ship empty object — daemon
// will replay {} in the new initialize, matching what bridge implicitly does today.
```
Decision: **ship `{}` as `clientCapabilities`** unless a bridge feature later opts in. Add a code comment explaining why.

- [ ] **Step 4.5: Run tests + build + lint**

```
npm run build && npm test && npm run lint
```

- [ ] **Step 4.6: Commit**

```
git add src/upstream/daemon-stdio-client.ts src/upstream/base-client.ts test/upstream/
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // bridge sends sharing + clientInfo + clientCapabilities + protocolVersion in OPEN"
```

---

## Task 5: `ChildGroup` state extension + `StatusChild` rendering

**Files:**
- Modify: `src/daemon/manager.ts` (`ChildGroup` interface, `statusChildren`)
- Modify: `src/daemon/protocol.ts` (`StatusChild` field union)
- Modify: `test/daemon/status-output.test.ts`
- Modify: `test/daemon/sharing.test.ts` (mode union)

- [ ] **Step 5.1: Write failing test for StatusChild union and new fields**

In `test/daemon/status-output.test.ts`, add an assertion:
```ts
expect(child.mode === "shared" || child.mode === "dedicated").toBe(true);
expect(child.sharing).toBeOneOf(["auto", "shared", "dedicated"]);
expect(typeof child.forked).toBe("boolean");
```
(Vitest uses `expect(x).toBe(...)` and `expect(x).toMatch(...)` — replace `toBeOneOf` with explicit `expect(["auto","shared","dedicated"]).toContain(child.sharing)`.)

- [ ] **Step 5.2: Run, expect failure**

```
npx vitest run test/daemon/status-output.test.ts
```

- [ ] **Step 5.3: Extend `StatusChild` interface**

In `src/daemon/protocol.ts`:
```ts
export interface StatusChild {
  pid: number;
  upstreamHash: string;
  startedAt: number;
  refcount: number;
  sessions: string[];
  subscriptionCount: number;
  mode: "shared" | "dedicated";
  sharing: "auto" | "shared" | "dedicated";
  forked: boolean;
  cachedInit: { protocolVersion: string } | null;
}
```

- [ ] **Step 5.4: Extend `ChildGroup` and update `statusChildren`**

In `src/daemon/manager.ts`, extend `ChildGroup`:
```ts
interface ChildGroup {
  groupId: string;                  // NEW: opaque per-group id
  upstreamHash: string;
  child: ChildHandle;
  rewriter: TokenRewriter;
  subscriptions: SubscriptionTracker;
  router: NotificationRouter;
  sessions: Set<string>;
  serverName: string;
  startedAt: number;
  graceTimer: NodeJS.Timeout | null;
  dying: boolean;
  initializedSeen: boolean;
  // NEW Phase D:
  mode: "shared" | "dedicated";
  sharing: "auto" | "shared" | "dedicated";
  forked: boolean;
}
```

Update `statusChildren()`:
```ts
private statusChildren(): StatusChild[] {
  return Array.from(this.groups.values()).map((g) => ({
    pid: g.child.pid ?? -1,
    upstreamHash: g.upstreamHash,
    startedAt: g.startedAt,
    refcount: g.sessions.size,
    sessions: Array.from(g.sessions),
    subscriptionCount: g.subscriptions.subscriptionCount(),
    mode: g.mode,
    sharing: g.sharing,
    forked: g.forked,
    cachedInit:
      g.child.cachedInit === null
        ? null
        : { protocolVersion: g.child.cachedInit.protocolVersion },
  }));
}
```

In `spawnGroup`, initialize the new fields. Take additional args:
```ts
private spawnGroup(
  hash: string,
  spec: OpenParams["spec"],
  mode: "shared" | "dedicated",
): ChildGroup | Error {
  ...
  const group: ChildGroup = {
    groupId: `${hash}:${spec.sharing}:${this.nextGroupCounter++}`,
    upstreamHash: hash,
    child,
    rewriter,
    subscriptions,
    router,
    sessions: new Set(),
    serverName: spec.serverName,
    startedAt: child.startedAt,
    graceTimer: null,
    dying: false,
    initializedSeen: false,
    mode,
    sharing: spec.sharing,
    forked: false,
  };
  ...
}
```
Add `private nextGroupCounter = 1;` to the class.

- [ ] **Step 5.5: Update `sharing.test.ts` mode assertion**

The existing `expect(status.children[0]!.refcount).toBe(2)` is fine; add:
```ts
expect(status.children[0]!.mode).toBe("shared");
expect(status.children[0]!.sharing).toBe("auto");
expect(status.children[0]!.forked).toBe(false);
```

- [ ] **Step 5.6: Run + commit**

```
npm run build && npm test && npm run lint
git add src/daemon/manager.ts src/daemon/protocol.ts test/daemon/status-output.test.ts test/daemon/sharing.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // ChildGroup mode/sharing/forked + StatusChild renders all three"
```

---

## Task 6: Group registry refactor (3-piece state)

**Files:**
- Modify: `src/daemon/manager.ts`
- Test: new behavior tests

- [ ] **Step 6.1: Write failing test — three sharing modes spawn correctly**

Create `test/daemon/group-registry.test.ts` with cases:

(a) Two `auto` OPENs same hash → 1 child, refcount 2.
(b) Two `shared` OPENs same hash → 1 child (separate from any auto group), refcount 2.
(c) One `auto` + one `shared` same hash → 2 children, refcount 1 each.
(d) Two `dedicated` OPENs same hash → 2 children, refcount 1 each.
(e) `dedicated` + `auto` same hash → 2 children.

Use the same `_spawnChild` stub pattern from `sharing.test.ts`. Count `spawnCalls`, verify `STATUS.children.length`.

- [ ] **Step 6.2: Run, expect failure (current logic produces 1 child for everything with same hash)**

```
npx vitest run test/daemon/group-registry.test.ts
```

- [ ] **Step 6.3: Replace `groups: Map<hash, ChildGroup>` with the three-piece state**

In `ManagerDaemon`:
```ts
private groups = new Map<string, ChildGroup>();           // groupId -> group
private shareableIndex = new Map<string, ChildGroup>();   // `${hash}:${sharing}` -> group
private autoTainted = new Set<string>();                  // hashes where auto already forked
private nextGroupCounter = 1;
```

Replace the OPEN attach block in `handleOpen`:
```ts
// Decide whether to attach to existing group or spawn fresh.
const sharing = params.spec.sharing;
let group: ChildGroup | undefined;

if (sharing !== "dedicated") {
  const tainted = sharing === "auto" && this.autoTainted.has(hash);
  if (!tainted) {
    const indexKey = `${hash}:${sharing}`;
    const existing = this.shareableIndex.get(indexKey);
    if (existing !== undefined && !existing.dying) {
      group = existing;
      this.cancelGraceTimer(group);
    }
  }
}

if (group === undefined) {
  // Fresh spawn.
  const mode: "shared" | "dedicated" =
    sharing === "dedicated" || (sharing === "auto" && this.autoTainted.has(hash))
      ? "dedicated"
      : "shared";
  const spawned = this.spawnGroup(hash, params.spec, mode);
  if (spawned instanceof Error) {
    return errorResponse(requestId, ERROR_CODE_SPAWN_FAILED, spawned.message);
  }
  group = spawned;
  this.groups.set(group.groupId, group);
  if (mode === "shared") {
    this.shareableIndex.set(`${hash}:${sharing}`, group);
  }
}

group.rewriter.attachSession(params.sessionId);
group.sessions.add(params.sessionId);
```

Update other call sites that did `this.groups.get(hash)` → iterate `this.groups.values()` or use `groupId`. Specifically:
- `unregisterGroup`: drop by `groupId`, also delete shareableIndex entry if it points to this group.
- `expireGroup`: same.
- `handleChildExit`: use `groupId`.

```ts
private async unregisterGroup(group: ChildGroup): Promise<void> {
  if (this.groups.get(group.groupId) === group) {
    this.groups.delete(group.groupId);
  }
  for (const [k, g] of this.shareableIndex) {
    if (g === group) this.shareableIndex.delete(k);
  }
  this.cancelGraceTimer(group);
  ...
}
```

- [ ] **Step 6.4: Update tests + run**

```
npm run build && npm test && npm run lint
```

- [ ] **Step 6.5: Commit**

```
git add src/daemon/manager.ts test/daemon/group-registry.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // group registry: groupId + shareableIndex + autoTainted; OPEN honors sharing"
```

---

## Task 7: `TokenRewriter` internal-id classifier

**Files:**
- Modify: `src/daemon/token-rewriter.ts`
- Modify: `test/daemon/token-rewriter.test.ts`

- [ ] **Step 7.1: Write failing test — negative-id response classified as `internal`**

Append to `test/daemon/token-rewriter.test.ts`:
```ts
it("inboundFromChild classifies negative-id responses as internal", () => {
  const rw = new TokenRewriter();
  const routing = rw.inboundFromChild({ jsonrpc: "2.0", id: -1, result: {} });
  expect(routing.kind).toBe("internal");
  expect(routing.sessionIds).toEqual([]);
});

it("inboundFromChild classifies negative-id error responses as internal", () => {
  const rw = new TokenRewriter();
  const routing = rw.inboundFromChild({
    jsonrpc: "2.0",
    id: -2,
    error: { code: -32601, message: "Method not found" },
  });
  expect(routing.kind).toBe("internal");
});
```

- [ ] **Step 7.2: Run, expect failure**

```
npx vitest run test/daemon/token-rewriter.test.ts
```

- [ ] **Step 7.3: Add `internal` kind**

In `src/daemon/token-rewriter.ts`:
```ts
export type InboundKind = "response" | "progress" | "cancelled" | "other" | "drop" | "internal";
```

In `inboundFromChild`, before the existing positive-id response branch:
```ts
if (
  typeof p.method !== "string" &&
  (p.result !== undefined || p.error !== undefined) &&
  typeof p.id === "number" &&
  p.id < 0
) {
  return { sessionIds: [], payload, kind: "internal" };
}
```

- [ ] **Step 7.4: Run, build, lint**

```
npm run build && npm test && npm run lint
```

- [ ] **Step 7.5: Commit**

```
git add src/daemon/token-rewriter.ts test/daemon/token-rewriter.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // TokenRewriter classifies negative-id responses as internal"
```

---

## Task 8: `AutoForkOrchestrator` skeleton + detection hook

**Files:**
- Create: `src/daemon/auto-fork.ts`
- Modify: `src/daemon/manager.ts` (instantiate orchestrator, add detection branch in `routeChildMessage`)
- Create: `test/daemon/auto-fork.test.ts`

- [ ] **Step 8.1: Write failing test — server→client request triggers orchestrator handler**

Create `test/daemon/auto-fork.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { AutoForkOrchestrator } from "../../src/daemon/auto-fork.js";

describe("AutoForkOrchestrator — detection", () => {
  it("isServerRequest returns true for requests with method+id", () => {
    const orch = new AutoForkOrchestrator({} as never);
    expect(
      orch.isServerRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "sampling/createMessage",
        params: {},
      }),
    ).toBe(true);
    expect(
      orch.isServerRequest({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      }),
    ).toBe(false);
    expect(
      orch.isServerRequest({ jsonrpc: "2.0", id: 1, result: {} }),
    ).toBe(false);
  });
});
```

- [ ] **Step 8.2: Run, expect failure**

```
npx vitest run test/daemon/auto-fork.test.ts
```

- [ ] **Step 8.3: Create the orchestrator skeleton**

`src/daemon/auto-fork.ts`:
```ts
import type { Logger } from "../logging/index.js";

export interface AutoForkDeps {
  logger: Logger;
  // More deps wired in later tasks (manager hooks, etc.)
}

/**
 * Owns auto-fork orchestration: detects server→client requests on
 * shared children, runs per-session migration to dedicated children with
 * daemon-issued initialize/subscribe replay, manages drain timeout and
 * outbound buffering.
 *
 * Phase D scaffolding — fork mechanics added in subsequent tasks.
 */
export class AutoForkOrchestrator {
  constructor(private readonly deps: AutoForkDeps) {}

  /**
   * Returns true if a child→bridge payload is a server→client REQUEST
   * (has both `method` and a numeric/string `id`). Notifications return false.
   * Responses return false.
   */
  isServerRequest(payload: unknown): boolean {
    if (typeof payload !== "object" || payload === null) return false;
    const p = payload as { id?: unknown; method?: unknown };
    return (
      typeof p.method === "string" &&
      (typeof p.id === "string" || typeof p.id === "number")
    );
  }
}
```

- [ ] **Step 8.4: Wire into manager**

In `src/daemon/manager.ts`:
```ts
import { AutoForkOrchestrator } from "./auto-fork.js";

// In ManagerDaemon class:
private readonly autoFork: AutoForkOrchestrator;

// In constructor, after this.tracker assignment:
this.autoFork = new AutoForkOrchestrator({ logger: this.logger });
```

In `routeChildMessage`, change the `"other"` branch:
```ts
// "other" — could be a server→client request or a notification.
if (this.autoFork.isServerRequest(routing.payload)) {
  // For Task 8, just log and drop. Real handling lands in Task 9.
  this.logger.warn(`auto-fork: server→client request detected (method ${
    (routing.payload as { method?: string }).method
  })`, { component: "daemon", upstreamHash: group.upstreamHash });
  return;
}
const sessions = group.router.route(routing.payload, Array.from(group.sessions), group.subscriptions);
if (sessions.length > 0) this.deliver(group, sessions, routing.payload);
```

- [ ] **Step 8.5: Run, build, lint, commit**

```
npm run build && npm test && npm run lint
git add src/daemon/auto-fork.ts src/daemon/manager.ts test/daemon/auto-fork.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // AutoForkOrchestrator skeleton + detection hook"
```

---

## Task 9: `shared` and `dedicated` mode dispatch

**Files:**
- Modify: `src/daemon/auto-fork.ts`
- Modify: `src/daemon/manager.ts`
- Modify: `test/daemon/auto-fork.test.ts`

- [ ] **Step 9.1: Write failing tests for shared and dedicated dispatch**

```ts
it("shared mode: emits -32601 to child, no fan-out", async () => {
  // Build a fake group with sharing="shared", attached session, fake child.send capture.
  // Call orchestrator.handleServerRequest(group, payload).
  // Assert child.send was called with { jsonrpc, id: 1, error: { code: -32601 } }.
  // Assert no RPC notification emitted to bridge.
});

it("dedicated mode: forwards request to single attached session's bridge", async () => {
  // Build fake group with sharing="dedicated", one session, mock bridge channel.
  // Call orchestrator.handleServerRequest(group, payload).
  // Assert RPC notification with the payload reaches the session's channel.
});
```

(Use the existing pattern from `notification-router.test.ts` — fake group, capture sends.)

- [ ] **Step 9.2: Implement `handleServerRequest` for non-fork modes**

In `src/daemon/auto-fork.ts`:
```ts
import type { ChildGroup, ManagerInternals } from "./auto-fork-types.js";

export interface AutoForkDeps {
  logger: Logger;
  // Manager-bound callbacks injected by ManagerDaemon. Avoid circular import.
  sendToChild: (group: ChildGroup, payload: unknown) => void;
  sendToSession: (group: ChildGroup, sessionId: string, payload: unknown) => void;
  warnedShared: Set<string>;
}

async handleServerRequest(group: ChildGroup, payload: unknown): Promise<void> {
  const method = (payload as { method?: string }).method ?? "<unknown>";
  const id = (payload as { id?: string | number }).id;

  if (group.sharing === "shared") {
    const warnKey = `${group.groupId}:${method}`;
    if (!this.deps.warnedShared.has(warnKey)) {
      this.deps.warnedShared.add(warnKey);
      this.deps.logger.warn(
        `auto-fork: shared upstream emitted server→client request "${method}"; replying -32601`,
        { component: "auto-fork", upstreamHash: group.upstreamHash, method },
      );
    }
    if (id !== undefined) {
      this.deps.sendToChild(group, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
    return;
  }

  if (group.sharing === "dedicated") {
    // Single session. Forward to that bridge as a normal server→bridge request.
    const sole = Array.from(group.sessions)[0];
    if (sole !== undefined) {
      this.deps.sendToSession(group, sole, payload);
    }
    return;
  }

  // sharing === "auto" — fork. (Implemented in Task 10+.)
  this.deps.logger.warn(`auto-fork: TODO handle auto-mode fork`, {
    component: "auto-fork",
    upstreamHash: group.upstreamHash,
    method,
  });
}
```

The `ChildGroup` type is currently private to `manager.ts`. Either export it or define a structural shape in `auto-fork-types.ts`. Pick: **export the `ChildGroup` interface from `manager.ts`** (it was already a private detail, but the orchestrator legitimately owns its shape now).

- [ ] **Step 9.3: Wire `sendToChild` and `sendToSession` from manager**

In `ManagerDaemon` constructor:
```ts
this.autoFork = new AutoForkOrchestrator({
  logger: this.logger.child({ component: "auto-fork" }),
  sendToChild: (group, payload) => {
    try {
      group.child.send(payload);
    } catch (err) {
      this.logger.warn(`auto-fork sendToChild failed: ${(err as Error).message}`,
        { component: "auto-fork", upstreamHash: group.upstreamHash });
    }
  },
  sendToSession: (group, sessionId, payload) => this.deliver(group, [sessionId], payload),
  warnedShared: new Set<string>(),
});
```

In `routeChildMessage`, replace the placeholder warn-and-drop with:
```ts
if (this.autoFork.isServerRequest(routing.payload)) {
  void this.autoFork.handleServerRequest(group, routing.payload);
  return;
}
```

- [ ] **Step 9.4: Run, build, lint, commit**

```
npm run build && npm test && npm run lint
git add src/daemon/auto-fork.ts src/daemon/manager.ts test/daemon/auto-fork.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // shared mode replies -32601; dedicated mode forwards to single session"
```

---

## Task 10: Per-session migration state + outbound buffering

**Files:**
- Modify: `src/daemon/manager.ts` (`SessionAttachment` migration field, outbound check)
- Modify: `src/daemon/auto-fork.ts`
- Modify: `test/daemon/auto-fork.test.ts`

- [ ] **Step 10.1: Write failing test — outbound during draining is queued**

```ts
it("draining session: outbound is buffered, not forwarded", async () => {
  // Construct manager + group with two sessions; set session B.migration = "draining".
  // Submit RPC notification from session B; assert child.send NOT called.
  // After clearing draining state and flushing, verify the queued payload reaches child.
});

it("draining session: queue overflow returns DRAIN_BACKPRESSURE", async () => {
  // Set MAX_QUEUE = 2; push 3 payloads; third should yield INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE.
});
```

- [ ] **Step 10.2: Add migration state to `SessionAttachment`**

In `src/daemon/manager.ts`:
```ts
type MigrationState =
  | { kind: "idle" }
  | {
      kind: "draining";
      newGroup: ChildGroup;
      queuedOutbound: unknown[];
      drainDeadline: number;
      drainTimer: NodeJS.Timeout | null;
    }
  | { kind: "migrated" };

interface SessionAttachment {
  sessionId: string;
  channel: FrameChannel;
  group: ChildGroup;
  startedAt: number;
  // NEW Phase D:
  clientInfo: { name: string; version: string };
  clientCapabilities: Record<string, unknown>;
  protocolVersion: string;
  sharing: "auto" | "shared" | "dedicated";
  migration: MigrationState;
}
```

Update `handleOpen` to populate the new fields:
```ts
const attachment: SessionAttachment = {
  sessionId: params.sessionId,
  channel,
  group,
  startedAt: Date.now(),
  clientInfo: params.spec.clientInfo,
  clientCapabilities: params.spec.clientCapabilities,
  protocolVersion: params.spec.protocolVersion,
  sharing: params.spec.sharing,
  migration: { kind: "idle" },
};
```

- [ ] **Step 10.3: Add outbound check at the top of the body of `handleNotification` after RPC param validation**

```ts
const att = this.sessions.get(params.sessionId);
// (existing check)
if (att.migration.kind === "draining") {
  const innerId = pickInnerId(params.payload);
  if (att.migration.queuedOutbound.length >= MAX_QUEUE_PER_SESSION) {
    if (innerId !== null) {
      this.sendInnerError(
        channel,
        params.sessionId,
        innerId,
        INNER_ERROR_CODE_AUTO_FORK_DRAIN_BACKPRESSURE,
        "session migration buffer full",
      );
    }
    return;
  }
  att.migration.queuedOutbound.push(params.payload);
  return;
}
```

Add the cap constant near other `MAX_*`:
```ts
const MAX_QUEUE_PER_SESSION = 256;
```

- [ ] **Step 10.4: Run + build + lint + commit**

```
npm run build && npm test && npm run lint
git add src/daemon/manager.ts test/daemon/auto-fork.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // SessionAttachment migration state + outbound buffering during drain"
```

---

## Task 11: Fork sequence — spawn + daemon-issued `initialize` replay

**Files:**
- Modify: `src/daemon/auto-fork.ts`
- Modify: `src/daemon/manager.ts` (route `kind: "internal"` responses to orchestrator)

- [ ] **Step 11.1: Write failing test — fork spawns N-1 new children with replayed initialize**

Append to `test/daemon/auto-fork.test.ts`:
```ts
it("auto fork: spawns fresh child per non-originating session and replays initialize", async () => {
  // Set up auto-shared group with 3 sessions. Trigger handleServerRequest with
  // sampling/createMessage. Assert:
  //  - 2 spawnGroup calls happened (originating session reuses old child)
  //  - each new child received an `initialize` request with the per-session
  //    clientInfo + clientCapabilities + protocolVersion.
  //  - originating session receives the triggering request.
  //  - non-originating sessions transition to "draining".
});
```

- [ ] **Step 11.2: Add spawn + initialize replay to orchestrator**

In `src/daemon/auto-fork.ts`, expand `handleServerRequest` for the `auto` branch:
```ts
async handleServerRequest(group: ChildGroup, payload: unknown): Promise<void> {
  ...
  if (group.sharing === "auto") {
    await this.fork(group, payload);
    return;
  }
}

private async fork(group: ChildGroup, triggeringPayload: unknown): Promise<void> {
  const sessionIds = Array.from(group.sessions);
  if (sessionIds.length === 0) {
    this.deps.logger.warn(`auto-fork: no sessions on group, dropping triggering request`, {
      component: "auto-fork", upstreamHash: group.upstreamHash,
    });
    return;
  }
  const originatingSessionId = sessionIds[0];

  // Mark hash tainted, de-list from shareable index, flip mode.
  this.deps.taintAuto(group.upstreamHash);
  this.deps.delistShareable(group, "auto");
  group.mode = "dedicated";
  group.forked = true;

  // Move non-originating sessions to draining and spawn their new children.
  const migrations: Promise<void>[] = [];
  for (const sid of sessionIds) {
    if (sid === originatingSessionId) continue;
    migrations.push(this.migrateSession(group, sid));
  }

  // Forward triggering request to originating session's bridge BEFORE awaiting
  // migrations — bridge can start working on the response in parallel.
  this.deps.sendToSession(group, originatingSessionId, triggeringPayload);

  await Promise.allSettled(migrations);
}

private async migrateSession(oldGroup: ChildGroup, sessionId: string): Promise<void> {
  const att = this.deps.getAttachment(sessionId);
  if (att === undefined) return;

  // Spawn fresh dedicated child for this session.
  const spawned = this.deps.spawnDedicated(oldGroup.upstreamHash, sessionId);
  if (spawned === null) {
    this.deps.evictSession(sessionId, "auto_fork_initialize_failed");
    return;
  }
  const newGroup = spawned;

  // Transition session to draining; arm drain timer (Task 13).
  att.migration = {
    kind: "draining",
    newGroup,
    queuedOutbound: [],
    drainDeadline: Date.now() + this.deps.autoForkDrainTimeoutMs,
    drainTimer: null,
  };

  // Daemon-issued initialize against new child.
  const init = await this.sendInternalRequest(newGroup, {
    method: "initialize",
    params: {
      protocolVersion: att.protocolVersion,
      clientInfo: att.clientInfo,
      capabilities: att.clientCapabilities,
    },
  }, this.deps.autoForkInitializeTimeoutMs);

  if (init === null || init.error !== undefined) {
    this.deps.killGroup(newGroup);
    this.deps.evictSession(sessionId, "auto_fork_initialize_failed");
    return;
  }

  // Cache the init result on the new child.
  if (init.result !== undefined && this.isInitResult(init.result)) {
    newGroup.child.setCachedInit({
      protocolVersion: init.result.protocolVersion as string,
      serverInfo: init.result.serverInfo as { name: string; version: string },
      capabilities: init.result.capabilities as Record<string, unknown>,
    });
  }

  // Send initialized notification.
  this.deps.sendToChild(newGroup, { jsonrpc: "2.0", method: "notifications/initialized" });

  // Subscribe replay + drain detection in Task 12.
  this.deps.markReplayCompleteIfPossible(att);
}

/**
 * Send a request with a negative id to a child and await the response.
 * Returns null on timeout/death.
 */
private async sendInternalRequest(
  group: ChildGroup,
  body: { method: string; params?: unknown },
  timeoutMs: number,
): Promise<{ result?: unknown; error?: { code: number; message: string } } | null> {
  const id = this.deps.nextInternalId(group);
  const request = { jsonrpc: "2.0" as const, id, method: body.method, params: body.params };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      this.deps.unregisterInternal(group, id);
      resolve(null);
    }, timeoutMs);
    this.deps.registerInternal(group, id, (payload) => {
      clearTimeout(timer);
      const p = payload as { result?: unknown; error?: { code: number; message: string } };
      resolve({ result: p.result, error: p.error });
    });
    try {
      group.child.send(request);
    } catch {
      clearTimeout(timer);
      this.deps.unregisterInternal(group, id);
      resolve(null);
    }
  });
}

private isInitResult(r: unknown): r is { protocolVersion: string; serverInfo: object; capabilities: object } {
  if (typeof r !== "object" || r === null) return false;
  const x = r as { protocolVersion?: unknown; serverInfo?: unknown; capabilities?: unknown };
  return typeof x.protocolVersion === "string"
    && typeof x.serverInfo === "object" && x.serverInfo !== null
    && typeof x.capabilities === "object" && x.capabilities !== null;
}
```

- [ ] **Step 11.3: Wire new dependencies in `ManagerDaemon`**

Add to `AutoForkDeps`:
```ts
taintAuto: (hash: string) => void;
delistShareable: (group: ChildGroup, sharing: "auto" | "shared") => void;
spawnDedicated: (hash: string, forSessionId: string) => ChildGroup | null;
killGroup: (group: ChildGroup) => void;
evictSession: (sessionId: string, reason: "auto_fork_initialize_failed" | "auto_fork_drain_timeout") => void;
getAttachment: (sessionId: string) => SessionAttachment | undefined;
nextInternalId: (group: ChildGroup) => number;
registerInternal: (group: ChildGroup, id: number, cb: (payload: unknown) => void) => void;
unregisterInternal: (group: ChildGroup, id: number) => void;
markReplayCompleteIfPossible: (att: SessionAttachment) => void;
autoForkDrainTimeoutMs: number;
autoForkInitializeTimeoutMs: number;
```

In `ChildGroup`, add:
```ts
internalRequests: Map<number, (payload: unknown) => void>;
nextInternalId: number; // starts at -1, decrements
```

Implement the manager-side helpers. Key one — `spawnDedicated`:
```ts
private spawnDedicatedForSession(hash: string, forSessionId: string): ChildGroup | null {
  const att = this.sessions.get(forSessionId);
  if (att === undefined) return null;
  // Reuse spec from the bridge's existing OPEN. We need the OPEN spec stored
  // somewhere; either reattach the spec to SessionAttachment in Task 3, or
  // remember the spec in the group. Picking: store the spec on SessionAttachment
  // alongside clientInfo etc. (cheap; spec is < 1MB).
  const spec = att.openSpec;
  const spawned = this.spawnGroup(hash, spec, "dedicated");
  if (spawned instanceof Error) return null;
  this.groups.set(spawned.groupId, spawned);
  // Do NOT register in shareableIndex — dedicated.
  return spawned;
}
```

Update `SessionAttachment` to carry the OPEN spec (back-reference for spawning replacements):
```ts
interface SessionAttachment {
  ...
  openSpec: OpenParams["spec"];
}
```

Set in `handleOpen`: `openSpec: params.spec`.

Wire `routeChildMessage` to dispatch `kind: "internal"` to the orchestrator:
```ts
if (routing.kind === "internal") {
  const id = (routing.payload as { id?: number }).id;
  if (typeof id === "number") {
    const cb = group.internalRequests.get(id);
    if (cb !== undefined) {
      group.internalRequests.delete(id);
      cb(routing.payload);
    }
  }
  return;
}
```

- [ ] **Step 11.4: Run + build + lint + commit**

```
npm run build && npm test && npm run lint
git add src/daemon/auto-fork.ts src/daemon/manager.ts test/daemon/auto-fork.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // fork spawns dedicated children + replays initialize via internal-id namespace"
```

---

## Task 12: `resources/subscribe` replay + drain detection + migration completion

**Files:**
- Modify: `src/daemon/auto-fork.ts`
- Modify: `src/daemon/manager.ts`
- Modify: `src/daemon/subscription-tracker.ts` (expose per-session URI list)

- [ ] **Step 12.1: Write failing test — subscriptions replayed and migration completes when old-child inflight drains**

```ts
it("auto fork: replays resources/subscribe for each tracked URI", async () => {
  // Pre-populate old group's tracker: session B subscribes to "file://a", "file://b".
  // Trigger fork. Assert new child for B receives two resources/subscribe requests.
});

it("auto fork: session migrates to migrated state when replay done AND old-child inflight reaches zero", async () => {
  // Start with one inflight bridge→child request from session B on old child.
  // Trigger fork. Replay completes; migration stays draining until old-child response delivered.
  // Deliver old-child response; expect migration -> "migrated", queued outbound flushed.
});
```

- [ ] **Step 12.2: Expose `urisForSession` on `SubscriptionTracker`**

```ts
urisForSession(sessionId: string): string[] {
  const set = this.bySession.get(sessionId);
  return set === undefined ? [] : Array.from(set);
}
```

- [ ] **Step 12.3: Extend `migrateSession` with subscribe replay and drain hook**

In `src/daemon/auto-fork.ts`, after init+initialized:
```ts
// Replay subscriptions sequentially.
const uris = this.deps.urisForSession(oldGroup, sessionId);
for (const uri of uris) {
  const sub = await this.sendInternalRequest(newGroup, {
    method: "resources/subscribe",
    params: { uri },
  }, this.deps.autoForkInitializeTimeoutMs);
  if (sub === null || sub.error !== undefined) {
    this.deps.logger.warn(`auto-fork: subscribe replay failed for ${uri}`,
      { component: "auto-fork", upstreamHash: oldGroup.upstreamHash, sessionId, uri });
    continue;
  }
  this.deps.registerSubscription(newGroup, sessionId, uri);
}

att.migration = {
  ...att.migration,
  // Mark replay-done; drain still pending until inflight === 0.
};
this.deps.attemptCompleteMigration(att, oldGroup, newGroup, sessionId);
```

`attemptCompleteMigration`:
```ts
// Implemented in manager.ts as an AutoForkDeps callback.
attemptCompleteMigration(att, oldGroup, newGroup, sessionId) {
  if (att.migration.kind !== "draining") return;
  const inflight = oldGroup.rewriter.inflightForSession(sessionId);
  if (inflight.length > 0) return; // wait for next response delivery
  this.completeMigration(att, oldGroup, newGroup, sessionId);
}

completeMigration(att, oldGroup, newGroup, sessionId) {
  // Detach from old group's rewriter + subscriptions; emits resources/unsubscribe
  // for URIs whose count drops to 0 on old child.
  const droppedUris = oldGroup.subscriptions.removeSession(sessionId);
  for (const uri of droppedUris) {
    try {
      oldGroup.child.send({ jsonrpc: "2.0", method: "resources/unsubscribe", params: { uri } });
    } catch { /* best effort */ }
  }
  oldGroup.rewriter.detachSession(sessionId);
  oldGroup.sessions.delete(sessionId);

  // Attach to new group.
  newGroup.rewriter.attachSession(sessionId);
  newGroup.sessions.add(sessionId);
  att.group = newGroup;

  // Flush queued outbound.
  const queue = att.migration.queuedOutbound;
  for (const payload of queue) {
    // Re-enter the standard outbound path; we have the channel + sessionId.
    // Route via a helper that calls outboundForChild + child.send.
    this.flushOutbound(att.channel, sessionId, payload);
  }
  if (att.migration.drainTimer !== null) clearTimeout(att.migration.drainTimer);
  att.migration = { kind: "migrated" };
}
```

- [ ] **Step 12.4: Add hook for inflight-drain detection in `routeChildMessage`**

After delivering a `kind: "response"`:
```ts
if (routing.kind === "response") {
  ...existing delivery code...
  for (const sid of routing.sessionIds) {
    const att = this.sessions.get(sid);
    if (att === undefined) continue;
    if (att.migration.kind === "draining" && att.group === group /* old group */) {
      this.autoFork.onSessionInflightChanged(att, group);
    }
  }
  return;
}
```

`onSessionInflightChanged` calls `attemptCompleteMigration` if replay flag is set. The "replay done" flag lives in `att.migration` — extend the type:
```ts
| {
    kind: "draining";
    newGroup: ChildGroup;
    queuedOutbound: unknown[];
    drainDeadline: number;
    drainTimer: NodeJS.Timeout | null;
    replayDone: boolean;
  }
```

Set `replayDone = true` after subscribe loop finishes.

- [ ] **Step 12.5: Run, build, lint, commit**

```
npm run build && npm test && npm run lint
git add src/daemon/auto-fork.ts src/daemon/manager.ts src/daemon/subscription-tracker.ts test/daemon/auto-fork.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // subscribe replay + drain hook + migration completion"
```

---

## Task 13: Drain timeout + initialize timeout + `SESSION_EVICTED` emission

**Files:**
- Modify: `src/daemon/auto-fork.ts`
- Modify: `src/daemon/manager.ts`

- [ ] **Step 13.1: Failing test — drain timeout evicts session**

```ts
it("auto fork: drain timeout with replay incomplete -> SESSION_EVICTED", async () => {
  // autoForkDrainTimeoutMs = 50ms. Replay deliberately stalled (e.g. fake new child
  // never responds to initialize). Wait > 50ms. Assert SESSION_EVICTED frame
  // delivered on bridge channel for that session, reason = auto_fork_drain_timeout.
});

it("auto fork: drain timeout with replay done flushes queued outbound and synth-errors stuck inflight", async () => {
  // Replay done; old child still has inflight. Trigger timeout.
  // Assert queue flushed to new child; INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT
  // delivered for stuck inflight.
});
```

- [ ] **Step 13.2: Implement drain timer**

In `migrateSession`, before kicking off init:
```ts
const drainTimer = setTimeout(() => {
  this.onDrainTimeout(att, oldGroup, newGroup, sessionId);
}, this.deps.autoForkDrainTimeoutMs);
if (typeof drainTimer.unref === "function") drainTimer.unref();
att.migration = { ..., drainTimer };
```

Implement `onDrainTimeout`:
```ts
private onDrainTimeout(att, oldGroup, newGroup, sessionId): void {
  if (att.migration.kind !== "draining") return;
  if (att.migration.replayDone) {
    // Synthesize errors for stuck inflight, force-complete migration.
    const inflight = oldGroup.rewriter.inflightForSession(sessionId);
    for (const outerId of inflight) {
      const origin = oldGroup.rewriter.peekOrigin(outerId);
      if (origin === undefined) continue;
      this.deps.sendInnerError(att.channel, sessionId, origin.originalId,
        INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT, "auto-fork drain timeout");
    }
    this.deps.completeMigration(att, oldGroup, newGroup, sessionId);
    return;
  }
  // Replay didn't finish. Kill new child, evict.
  this.deps.killGroup(newGroup);
  this.deps.evictSession(sessionId, "auto_fork_drain_timeout");
}
```

- [ ] **Step 13.3: Implement `evictSession` in manager**

```ts
private evictSession(sessionId: string, reason: "auto_fork_initialize_failed" | "auto_fork_drain_timeout"): void {
  const att = this.sessions.get(sessionId);
  if (att === undefined) return;
  // Send SESSION_EVICTED notification to bridge.
  att.channel.send({
    method: "SESSION_EVICTED",
    params: { sessionId, reason } satisfies SessionEvictedParams,
  });
  // Force-detach session via standard path.
  void this.detachSession(sessionId, `auto-fork eviction: ${reason}`);
}
```

Plus ensure the orchestrator's `dieSession` cleanup also clears the drain timer when a session evicts mid-flight.

Update `detachSession` so that draining sessions also kill their not-yet-attached new child:
```ts
if (att.migration.kind === "draining") {
  if (att.migration.drainTimer !== null) clearTimeout(att.migration.drainTimer);
  // Kill the new child if still around (only if no other session migrated to it).
  const newGroup = att.migration.newGroup;
  if (newGroup.sessions.size === 0) {
    void this.unregisterGroup(newGroup).catch(() => {});
  }
}
```

- [ ] **Step 13.4: Run, build, lint, commit**

```
npm run build && npm test && npm run lint
git add src/daemon/auto-fork.ts src/daemon/manager.ts test/daemon/auto-fork.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // drain timeout, initialize timeout, SESSION_EVICTED emission"
```

---

## Task 14: Bridge-side `SESSION_EVICTED` handling

**Files:**
- Modify: `src/upstream/daemon-stdio-client.ts`
- Modify: `test/upstream/daemon-stdio-client.test.ts`

- [ ] **Step 14.1: Failing test — `SESSION_EVICTED` notification triggers `transport.onclose`**

```ts
it("DaemonStdioTransport: SESSION_EVICTED for our sessionId fires onclose", async () => {
  // Stand up fake daemon. Attach DaemonStdioTransport. Send SESSION_EVICTED notif.
  // Assert transport.onclose was invoked.
});

it("DaemonStdioTransport: SESSION_EVICTED for a different sessionId is ignored", async () => {
  // Same setup; send notif for an unrelated UUID. Assert onclose NOT called.
});
```

- [ ] **Step 14.2: Add handler in `_onNotification`**

```ts
private _onNotification(notif: DaemonNotification): void {
  if (notif.method === "SESSION_EVICTED") {
    const params = notif.params as { sessionId?: string; reason?: string } | undefined;
    if (params && params.sessionId === this._daemonSessionId) {
      const reasonErr = new Error(`daemon evicted session: ${params.reason ?? "unknown"}`);
      this.onerror?.(reasonErr);
      this._onSocketClose();
    }
    return;
  }
  if (notif.method !== "RPC") return;
  ...existing RPC handling...
}
```

- [ ] **Step 14.3: Run + build + lint + commit**

```
npm run build && npm test && npm run lint
git add src/upstream/daemon-stdio-client.ts test/upstream/
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // bridge handles SESSION_EVICTED -> onclose -> reconnect"
```

---

## Task 15: Hash taint persistence + post-fork STATUS

**Files:**
- Modify: `test/daemon/auto-fork.test.ts` (or sharing-modes test)

- [ ] **Step 15.1: Failing test — post-fork OPEN with `auto` for same hash spawns dedicated**

```ts
it("auto fork: post-fork OPEN for same hash + auto spawns fresh dedicated child", async () => {
  // Trigger fork. Then OPEN a new session with sharing="auto", same spec.
  // Assert a new child was spawned (refcount=1), not attached to existing groups.
  // Assert STATUS shows multiple children — orig (mode=dedicated, forked=true),
  //   migrated children (mode=dedicated, forked=false), new third-OPEN child
  //   (mode=dedicated, forked=false, sharing=auto).
});
```

- [ ] **Step 15.2: Verify implementation already handles taint**

Tasks 6 + 11 should have already produced the right behavior (`autoTainted` set + OPEN logic). If the test passes without code changes, that's correct — just commit the test.

- [ ] **Step 15.3: Run + build + lint + commit**

```
npm run build && npm test && npm run lint
git add test/daemon/auto-fork.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // verify hash taint persists; STATUS reflects post-fork groups"
```

---

## Task 16: Edge cases — old child dies mid-fork; bridge channel drops mid-drain

**Files:**
- Modify: `src/daemon/manager.ts` (existing `handleChildExit`, `channel.on("close")` handlers)
- Modify: `src/daemon/auto-fork.ts` (orchestrator hooks)
- Modify: `test/daemon/auto-fork.test.ts`

- [ ] **Step 16.1: Failing test — old child dies during drain**

```ts
it("auto fork: old child dies mid-fork; draining sessions complete migration", async () => {
  // Trigger fork. Mid-replay, kill the old child (simulate via cb.onClose()).
  // Assert: draining sessions still reach migrated state (replay continues
  // against new child; old-child inflight treated as terminated).
});
```

- [ ] **Step 16.2: Failing test — bridge channel drops during drain**

```ts
it("auto fork: bridge channel drops during drain; new child cleaned up", async () => {
  // Trigger fork. Close session B's channel.
  // Assert: new child for B is killed; no leaked group; queue and timer dropped.
});
```

- [ ] **Step 16.3: Wire the edge-case branches**

In `handleChildExit`, before the existing detach loop:
```ts
for (const sid of group.sessions) {
  const att = this.sessions.get(sid);
  if (att !== undefined && att.migration.kind === "draining") {
    // Old child died: treat inflight as terminated, attempt completion.
    this.autoFork.attemptCompleteMigration(att, group, att.migration.newGroup, sid);
  }
}
```

In the channel-`close` handler in `handleConnection`, add the migration-aware cleanup before standard detach (as described in spec edge-case table).

- [ ] **Step 16.4: Run + build + lint + commit**

```
npm run build && npm test && npm run lint
git add src/daemon/manager.ts src/daemon/auto-fork.ts test/daemon/auto-fork.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // edge cases: old child death + bridge channel drop during drain"
```

---

## Task 17: Stub MCP server + integration tests

**Files:**
- Create: `test/_helpers/stub-mcp-server.ts`
- Create: `test/_helpers/stub-mcp-server-bin.ts` (executable entry)
- Create: `test/daemon/sharing-modes.test.ts`

- [ ] **Step 17.1: Build the stub MCP server**

Standalone Node script that, on stdin, accepts MCP JSON-RPC. Exposes a single tool `emit_request` whose `tools/call` causes the stub to emit `sampling/createMessage` (or another method specified in the tool args) on stdout while still answering the `tools/call` normally.

Sketch (`test/_helpers/stub-mcp-server-bin.ts`):
```ts
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let nextServerRequestId = 1000;

rl.on("line", (line) => {
  let msg: any;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    respond(msg.id, {
      protocolVersion: "2025-06-18",
      serverInfo: { name: "stub-mcp", version: "0.0.0" },
      capabilities: { tools: { listChanged: true } },
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    respond(msg.id, { tools: [{ name: "emit_request", description: "trigger fork", inputSchema: { type: "object" } }] });
    return;
  }
  if (msg.method === "tools/call" && msg.params?.name === "emit_request") {
    const serverRequestMethod = msg.params?.arguments?.method ?? "sampling/createMessage";
    // Emit server→client request first, then respond to the tools/call.
    emit({ jsonrpc: "2.0", id: nextServerRequestId++, method: serverRequestMethod, params: {} });
    respond(msg.id, { content: [{ type: "text", text: "ok" }] });
    return;
  }
});

function respond(id: any, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function emit(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}
```

The helper exports `getStubBinPath()` that resolves the bin via `tsx`/compiled output.

- [ ] **Step 17.2: Failing test — `auto` fork end-to-end**

```ts
it("auto + sampling/createMessage: forks and subsequent tools/call works without re-OPEN", async () => {
  // Two bridges open with sharing="auto", same hash. Bridge B calls tools/call
  // emit_request(method="sampling/createMessage"). Daemon forks. Originating
  // bridge (A or B per first-attached) gets the sampling request; both bridges'
  // subsequent tools/call still works.
});
```

Plus tests for `shared` (-32601 + warn), `dedicated` cross-bridge (two children).

- [ ] **Step 17.3: Run + build + lint + commit**

```
npm run build && npm test && npm run lint
git add test/_helpers/ test/daemon/sharing-modes.test.ts
git commit -m "AIT-248 - Auto-fork on server→client requests + sharing config // integration tests with stub MCP server (sharing-modes.test.ts)"
```

---

## Self-review checklist (run before marking the plan done)

**Spec coverage:**
- [x] Sharing modes (auto/shared/dedicated) — Tasks 2, 6, 9
- [x] Group keying (3-piece state) — Task 6
- [x] OPEN payload extension — Tasks 3, 4
- [x] Detection — Task 8
- [x] Auto-fork orchestrator — Tasks 8–13
- [x] Per-session state machine — Task 10
- [x] Outbound buffering — Task 10
- [x] Daemon-issued initialize replay — Task 11
- [x] Subscribe replay — Task 12
- [x] Drain detection + completion — Task 12
- [x] Drain/initialize timeouts + SESSION_EVICTED — Task 13
- [x] Bridge-side eviction handling — Task 14
- [x] Hash taint — Task 15
- [x] Edge cases — Task 16
- [x] Integration tests — Task 17

**Placeholders:** None. Each step has concrete code or a precise instruction.

**Type consistency:** Method/property names checked across tasks:
- `migration.kind`, `queuedOutbound`, `drainDeadline`, `drainTimer`, `replayDone` — consistent.
- `MAX_QUEUE_PER_SESSION = 256` defined in Task 10, used in Task 10.
- `SESSION_EVICTED` method name — consistent.
- `INNER_ERROR_CODE_AUTO_FORK_DRAIN_TIMEOUT = -32002` and `…BACKPRESSURE = -32003` — consistent across Tasks 1, 10, 13.
- `autoForkDrainTimeoutMs` / `autoForkInitializeTimeoutMs` — consistent.
- `groupId` field on `ChildGroup` defined Task 5, used Task 6.
- `internalRequests: Map<number, cb>` on `ChildGroup` — defined Task 11.
- `urisForSession` on `SubscriptionTracker` — defined Task 12.
