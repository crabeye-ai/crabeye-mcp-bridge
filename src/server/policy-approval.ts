import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";
import type { InputRequiredResult, ServerContext } from "@modelcontextprotocol/server";

export interface ApprovalState {
  toolKey: string;
  argsHash: string;
  jti: string;
}

export const APPROVAL_INPUT_KEY = "approval";

export const APPROVAL_TTL_SECONDS = 600;

export function hashArgs(args: Record<string, unknown> | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify(args ?? {}))
    .digest("hex");
}

export function createApprovalCodec(): RequestStateCodec<ApprovalState> {
  return createRequestStateCodec<ApprovalState>({
    key: randomBytes(32),
    ttlSeconds: APPROVAL_TTL_SECONDS,
  });
}

export class ApprovalFlow {
  private readonly codec = createApprovalCodec();
  private readonly used = new Map<string, number>();

  readonly verify = (state: string, ctx: ServerContext): Promise<ApprovalState> =>
    this.codec.verify(state, ctx);

  /**
   * Whether this request carries the client's answer to an approval asked for
   * earlier: "approved" when it accepted; throws when it declined or the answer
   * is for another call or was already used; undefined when there is no answer.
   */
  answered(toolKey: string, args: Record<string, unknown> | undefined, ctx: ServerContext): "approved" | undefined {
    const state = ctx.mcpReq.requestState<ApprovalState>();
    const view = inputResponse(ctx.mcpReq.inputResponses, APPROVAL_INPUT_KEY);
    if (state === undefined || view.kind !== "elicit") return undefined;
    if (state.toolKey !== toolKey || state.argsHash !== hashArgs(args)) {
      throw new Error(`Tool ${toolKey} approval does not match this call — request approval again`);
    }
    this.consume(state.jti, toolKey);
    if (view.action === "accept") return "approved";
    throw new Error(`Tool ${toolKey} was declined by user`);
  }

  /** Asks the client to approve the call, with `message` as the question. */
  async ask(toolKey: string, args: Record<string, unknown> | undefined, message: string): Promise<InputRequiredResult> {
    return inputRequired({
      inputRequests: {
        [APPROVAL_INPUT_KEY]: inputRequired.elicit({ message, requestedSchema: { type: "object", properties: {} } }),
      },
      requestState: await this.codec.mint({
        toolKey,
        argsHash: hashArgs(args),
        jti: randomUUID(),
      }),
    });
  }

  private consume(jti: string, toolKey: string): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.used) {
      if (expiresAt <= now) this.used.delete(id);
    }
    if (this.used.has(jti)) {
      throw new Error(`Tool ${toolKey} approval was already used — request approval again`);
    }
    this.used.set(jti, now + (APPROVAL_TTL_SECONDS + 1) * 1000);
  }
}
