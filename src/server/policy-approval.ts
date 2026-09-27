import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  ProtocolError,
  ProtocolErrorCode,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";
import type {
  ElicitRequestFormParams,
  InputRequiredResult,
  ServerContext,
} from "@modelcontextprotocol/server";

export type ElicitationCapability = { form?: unknown; url?: unknown } | undefined;

export function elicitationCapability(ctx: ServerContext): ElicitationCapability {
  const envelope = ctx.mcpReq.envelope as
    | Record<string, { elicitation?: ElicitationCapability } | undefined>
    | undefined;
  return envelope?.[CLIENT_CAPABILITIES_META_KEY]?.elicitation;
}

export function cannotServeFormElicitation(cap: ElicitationCapability): boolean {
  if (cap === undefined) return true;
  return cap.url !== undefined && cap.form === undefined;
}

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
  private readonly answered = new Map<string, number>();

  readonly verify = (state: string, ctx: ServerContext): Promise<ApprovalState> =>
    this.codec.verify(state, ctx);

  async resolve(
    toolKey: string,
    args: Record<string, unknown> | undefined,
    request: ElicitRequestFormParams,
    ctx: ServerContext,
  ): Promise<"approved" | InputRequiredResult> {
    const state = ctx.mcpReq.requestState<ApprovalState>();
    const view = inputResponse(ctx.mcpReq.inputResponses, APPROVAL_INPUT_KEY);

    if (state !== undefined && view.kind === "elicit") {
      if (state.toolKey !== toolKey || state.argsHash !== hashArgs(args)) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidRequest,
          `Tool ${toolKey} approval does not match this call — request approval again`,
        );
      }
      this.consume(state.jti, toolKey);
      if (view.action === "accept") return "approved";
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        `Tool ${toolKey} was declined by user`,
      );
    }

    return inputRequired({
      inputRequests: {
        [APPROVAL_INPUT_KEY]: inputRequired.elicit(request),
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
    for (const [id, expiresAt] of this.answered) {
      if (expiresAt <= now) this.answered.delete(id);
    }
    if (this.answered.has(jti)) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidRequest,
        `Tool ${toolKey} approval was already used — request approval again`,
      );
    }
    this.answered.set(jti, now + (APPROVAL_TTL_SECONDS + 1) * 1000);
  }
}
