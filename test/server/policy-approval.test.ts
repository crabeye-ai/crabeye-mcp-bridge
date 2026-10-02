import { describe, it, expect, vi } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  Client,
  InMemoryTransport,
  ProtocolErrorCode,
} from "@modelcontextprotocol/client";
import type { CallToolResult, ElicitResult, Tool } from "@modelcontextprotocol/client";
import { ToolRegistry } from "../../src/server/tool-registry.js";
import { BridgeServer } from "../../src/server/bridge-server.js";
import { PolicyEngine } from "../../src/policy/policy-engine.js";
import {
  createApprovalCodec,
  hashArgs,
} from "../../src/server/policy-approval.js";
import type { UpstreamClient } from "../../src/upstream/types.js";

function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: "object" as const },
  };
}

function makeMockUpstreamClient(
  name: string,
  overrides?: Partial<UpstreamClient>,
): UpstreamClient {
  return {
    name,
    status: "connected",
    tools: [],
    connect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: `called on ${name}` }],
    } satisfies CallToolResult),
    close: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue(undefined),
    reconnect: vi.fn().mockResolvedValue(undefined),
    retryNow: vi.fn().mockResolvedValue(undefined),
    onStatusChange: vi.fn().mockReturnValue(() => {}),
    onToolsChanged: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}

type ElicitAnswer = ElicitResult["action"];

function tamper(wire: string): string {
  const middle = Math.floor(wire.length / 2);
  const replacement = wire[middle] === "A" ? "B" : "A";
  return wire.slice(0, middle) + replacement + wire.slice(middle + 1);
}

async function pairWithPolicy(opts: {
  era: "legacy" | "modern";
  policy: "prompt" | "never";
  elicit?: ElicitAnswer | ((message: string) => ElicitAnswer);
  manual?: boolean;
  elicitationCapability?: { form?: Record<string, never>; url?: Record<string, never> };
}) {
  const registry = new ToolRegistry();
  registry.setToolsForSource("linear", [
    makeTool("linear__create_issue"),
    makeTool("linear__delete_issue"),
  ]);

  const upstream = makeMockUpstreamClient("linear");

  const server = new BridgeServer({
    toolRegistry: registry,
    policyEngine: new PolicyEngine("always", {
      linear: { toolPolicy: opts.policy },
    }),
    getUpstreamClient: (name) => (name === "linear" ? upstream : undefined),
  });

  const elicitHandler = vi.fn(
    async (request: { params: { message: string } }): Promise<ElicitResult> => {
      const answer =
        typeof opts.elicit === "function"
          ? opts.elicit(request.params.message)
          : (opts.elicit ?? "accept");
      return answer === "accept"
        ? { action: "accept", content: {} }
        : { action: answer };
    },
  );

  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    {
      capabilities:
        opts.elicitationCapability !== undefined
          ? { elicitation: opts.elicitationCapability }
          : opts.elicit !== undefined
            ? { elicitation: {} }
            : {},
      ...(opts.era === "modern"
        ? { versionNegotiation: { mode: "auto" as const } }
        : {}),
      ...(opts.manual ? { inputRequired: { autoFulfill: false } } : {}),
    },
  );
  if (opts.elicit !== undefined) {
    client.setRequestHandler("elicitation/create", elicitHandler);
  }

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    server,
    client,
    upstream,
    elicitHandler,
    async cleanup() {
      await client.close();
      await server.close();
    },
  };
}

describe.each(["legacy", "modern"] as const)(
  "prompt policy approval (%s era)",
  (era) => {
    it("negotiates the expected era", async () => {
      const { client, cleanup } = await pairWithPolicy({ era, policy: "prompt", elicit: "accept" });
      expect(client.getProtocolEra()).toBe(era);
      await cleanup();
    });

    it("runs the tool when the user accepts", async () => {
      const { client, upstream, elicitHandler, cleanup } = await pairWithPolicy({
        era,
        policy: "prompt",
        elicit: "accept",
      });

      const result = await client.callTool({
        name: "linear__create_issue",
        arguments: { title: "Bug" },
      });

      expect(result.content).toEqual([
        { type: "text", text: "called on linear" },
      ]);
      expect(elicitHandler).toHaveBeenCalledOnce();
      expect(elicitHandler.mock.calls[0][0].params.message).toContain(
        "linear__create_issue",
      );
      expect(upstream.callTool).toHaveBeenCalledWith({
        name: "create_issue",
        arguments: { title: "Bug" },
      });

      await cleanup();
    });

    it("prompts again on every call — approvals do not carry over", async () => {
      const { client, upstream, elicitHandler, cleanup } = await pairWithPolicy({
        era,
        policy: "prompt",
        elicit: "accept",
      });

      await client.callTool({ name: "linear__create_issue", arguments: { n: 1 } });
      await client.callTool({ name: "linear__create_issue", arguments: { n: 1 } });

      expect(elicitHandler).toHaveBeenCalledTimes(2);
      expect(upstream.callTool).toHaveBeenCalledTimes(2);

      await cleanup();
    });

    it("rejects with InvalidRequest and skips the upstream when the user declines", async () => {
      const { client, upstream, cleanup } = await pairWithPolicy({
        era,
        policy: "prompt",
        elicit: "decline",
      });

      const failure = await client
        .callTool({ name: "linear__create_issue", arguments: {} })
        .then(() => undefined, (err: unknown) => err as { code?: number; message: string });
      expect(failure?.message).toMatch(/declined by user/);
      expect(failure?.code).toBe(ProtocolErrorCode.InvalidRequest);
      expect(upstream.callTool).not.toHaveBeenCalled();

      await cleanup();
    });

    it("rejects on cancel", async () => {
      const { client, upstream, cleanup } = await pairWithPolicy({
        era,
        policy: "prompt",
        elicit: "cancel",
      });

      await expect(
        client.callTool({ name: "linear__create_issue", arguments: {} }),
      ).rejects.toThrow(/declined by user/);
      expect(upstream.callTool).not.toHaveBeenCalled();

      await cleanup();
    });

    it("blocks never-policy tools without prompting", async () => {
      const { client, upstream, elicitHandler, cleanup } = await pairWithPolicy({
        era,
        policy: "never",
        elicit: "accept",
      });

      await expect(
        client.callTool({ name: "linear__create_issue", arguments: {} }),
      ).rejects.toThrow(/disabled by policy/);
      expect(elicitHandler).not.toHaveBeenCalled();
      expect(upstream.callTool).not.toHaveBeenCalled();

      await cleanup();
    });
  },
);

describe.each(["legacy", "modern"] as const)("prompt policy with a url-only elicitation capability (%s era)", (era) => {
  it("rejects with the v1 protocol error — the approval prompt is form-mode", async () => {
    const { client, upstream, cleanup } = await pairWithPolicy({
      era,
      policy: "prompt",
      elicitationCapability: { url: {} },
    });

    const failure = await client
      .callTool({ name: "linear__create_issue", arguments: {} })
      .then(() => undefined, (err: unknown) => err as { code?: number; message: string });
    expect(failure?.message).toMatch(/does not support elicitation/);
    expect(failure?.code).toBe(ProtocolErrorCode.InvalidRequest);
    expect(upstream.callTool).not.toHaveBeenCalled();

    await cleanup();
  });
});

describe("prompt policy without client elicitation support", () => {
  it("rejects with the v1 protocol error before any approval round (legacy era)", async () => {
    const { client, upstream, cleanup } = await pairWithPolicy({
      era: "legacy",
      policy: "prompt",
    });

    const failure = await client
      .callTool({ name: "linear__create_issue", arguments: {} })
      .then(() => undefined, (err: unknown) => err as { code?: number; message: string });
    expect(failure?.message).toMatch(/does not support elicitation/);
    expect(failure?.code).toBe(ProtocolErrorCode.InvalidRequest);
    expect(upstream.callTool).not.toHaveBeenCalled();

    await cleanup();
  });

  it("ignores an elicitation capability claimed only in request _meta (legacy era)", async () => {
    const { client, upstream, cleanup } = await pairWithPolicy({
      era: "legacy",
      policy: "prompt",
    });

    const failure = await client
      .callTool({
        name: "linear__create_issue",
        arguments: {},
        _meta: { [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } } },
      })
      .then(() => undefined, (err: unknown) => err as { code?: number; message: string });
    expect(failure?.message).toMatch(/does not support elicitation/);
    expect(upstream.callTool).not.toHaveBeenCalled();

    await cleanup();
  });

  it("fails the call instead of running the tool (modern era)", async () => {
    const { client, upstream, cleanup } = await pairWithPolicy({
      era: "modern",
      policy: "prompt",
    });

    await expect(
      client.callTool({ name: "linear__create_issue", arguments: {} }),
    ).rejects.toThrow(/capabilit|elicitation/i);
    expect(upstream.callTool).not.toHaveBeenCalled();

    await cleanup();
  });
});

describe("approval state binding (manual MRTR, modern era)", () => {
  type Round = { requestState?: string; inputRequests?: Record<string, unknown> };
  const accept = { approval: { action: "accept", content: {} } };

  async function firstRound(client: Client, name: string, args: Record<string, unknown>) {
    const round = (await client.callTool(
      { name, arguments: args },
      { allowInputRequired: true },
    )) as unknown as Round;
    expect(typeof round.requestState).toBe("string");
    expect(round.inputRequests).toHaveProperty("approval");
    return round.requestState!;
  }

  function redeem(client: Client, params: Record<string, unknown>) {
    return client.callTool(params as never, { allowInputRequired: true });
  }

  it("redeems an approval only for the exact tool and arguments it was minted for", async () => {
    const { client, upstream, cleanup } = await pairWithPolicy({
      era: "modern",
      policy: "prompt",
      elicit: "accept",
      manual: true,
    });
    const requestState = await firstRound(client, "linear__create_issue", { title: "Bug" });

    await expect(
      client.callTool(
        { name: "linear__create_issue", arguments: { title: "Other" }, inputResponses: accept, requestState } as never,
        { allowInputRequired: true },
      ),
    ).rejects.toThrow(/does not match this call/);

    await expect(
      client.callTool(
        { name: "linear__delete_issue", arguments: { title: "Bug" }, inputResponses: accept, requestState } as never,
        { allowInputRequired: true },
      ),
    ).rejects.toThrow(/does not match this call/);

    expect(upstream.callTool).not.toHaveBeenCalled();

    const result = await client.callTool(
      { name: "linear__create_issue", arguments: { title: "Bug" }, inputResponses: accept, requestState } as never,
      { allowInputRequired: true },
    );
    expect(result.content).toEqual([{ type: "text", text: "called on linear" }]);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);

    await cleanup();
  });

  it("is single-use: an answered round cannot be redeemed again", async () => {
    const { client, upstream, cleanup } = await pairWithPolicy({
      era: "modern",
      policy: "prompt",
      elicit: "accept",
      manual: true,
    });
    const params = { name: "linear__create_issue", arguments: { title: "Bug" } };
    const requestState = await firstRound(client, params.name, params.arguments);

    await redeem(client, { ...params, inputResponses: accept, requestState });
    expect(upstream.callTool).toHaveBeenCalledTimes(1);

    await expect(
      redeem(client, { ...params, inputResponses: accept, requestState }),
    ).rejects.toThrow(/already used/);
    expect(upstream.callTool).toHaveBeenCalledTimes(1);

    await cleanup();
  });

  it("consumes a declined round too — a later accept on the same state is refused", async () => {
    const { client, upstream, cleanup } = await pairWithPolicy({
      era: "modern",
      policy: "prompt",
      elicit: "accept",
      manual: true,
    });
    const params = { name: "linear__create_issue", arguments: { title: "Bug" } };
    const requestState = await firstRound(client, params.name, params.arguments);
    const decline = { approval: { action: "decline" } };

    await expect(
      redeem(client, { ...params, inputResponses: decline, requestState }),
    ).rejects.toThrow(/declined by user/);
    await expect(
      redeem(client, { ...params, inputResponses: accept, requestState }),
    ).rejects.toThrow(/already used/);
    expect(upstream.callTool).not.toHaveBeenCalled();

    await cleanup();
  });

  it("re-prompts when the echoed state carries no answer", async () => {
    const { client, upstream, cleanup } = await pairWithPolicy({
      era: "modern",
      policy: "prompt",
      elicit: "accept",
      manual: true,
    });
    const requestState = await firstRound(client, "linear__create_issue", { title: "Bug" });

    const again = (await client.callTool(
      { name: "linear__create_issue", arguments: { title: "Bug" }, inputResponses: {}, requestState } as never,
      { allowInputRequired: true },
    )) as unknown as Round;
    expect(typeof again.requestState).toBe("string");
    expect(again.inputRequests).toHaveProperty("approval");
    expect(upstream.callTool).not.toHaveBeenCalled();

    await cleanup();
  });

  it("rejects a tampered state with the SDK's frozen invalid-requestState error", async () => {
    const { client, upstream, cleanup } = await pairWithPolicy({
      era: "modern",
      policy: "prompt",
      elicit: "accept",
      manual: true,
    });
    const requestState = await firstRound(client, "linear__create_issue", { title: "Bug" });
    const tampered = tamper(requestState);

    await expect(
      client.callTool(
        { name: "linear__create_issue", arguments: { title: "Bug" }, inputResponses: accept, requestState: tampered } as never,
        { allowInputRequired: true },
      ),
    ).rejects.toThrow(/Invalid or expired requestState/);
    expect(upstream.callTool).not.toHaveBeenCalled();

    await cleanup();
  });
});

describe("approval codec", () => {
  it("round-trips the payload it minted", async () => {
    const codec = createApprovalCodec();
    const wire = await codec.mint({ toolKey: "linear__create_issue", argsHash: "abc", jti: "j1" });
    const back = await codec.verify(wire, {} as never);
    expect(back).toEqual({ toolKey: "linear__create_issue", argsHash: "abc", jti: "j1" });
  });

  it("rejects a tampered wire value", async () => {
    const codec = createApprovalCodec();
    const wire = await codec.mint({ toolKey: "t", argsHash: "h", jti: "j" });
    const tampered = tamper(wire);
    await expect(codec.verify(tampered, {} as never)).rejects.toThrow();
  });

  it("rejects state minted by a different process (different key)", async () => {
    const codecA = createApprovalCodec();
    const codecB = createApprovalCodec();
    const wire = await codecA.mint({ toolKey: "t", argsHash: "h", jti: "j" });
    await expect(codecB.verify(wire, {} as never)).rejects.toThrow();
  });
});

describe("hashArgs", () => {
  it("is stable for identical args and distinguishes different args", () => {
    expect(hashArgs({ a: 1 })).toBe(hashArgs({ a: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(hashArgs(undefined)).toBe(hashArgs({}));
  });

  it("is deliberately not key-order canonical — drift means re-prompt, never a false match", () => {
    expect(hashArgs({ a: 1, b: 2 })).not.toBe(hashArgs({ b: 2, a: 1 }));
  });
});
