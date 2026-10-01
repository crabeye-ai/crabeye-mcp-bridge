import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import type {
  ClientCapabilities,
  Implementation,
  ProtocolEra,
  Server,
  ServerContext,
} from "@modelcontextprotocol/server";

export interface ClientIdentity {
  name: string;
  version: string;
  protocolVersion?: string;
}

type ElicitationCapability = ClientCapabilities["elicitation"];

export type HandshakeSource = Pick<
  Server,
  "getClientVersion" | "getNegotiatedProtocolVersion" | "getClientCapabilities"
>;

interface RequestEnvelope {
  [CLIENT_INFO_META_KEY]?: Implementation;
  [PROTOCOL_VERSION_META_KEY]?: string;
  [CLIENT_CAPABILITIES_META_KEY]?: ClientCapabilities;
}

function requestEnvelope(ctx: ServerContext | undefined): RequestEnvelope | undefined {
  return ctx?.mcpReq.envelope as RequestEnvelope | undefined;
}

function toIdentity(
  info: Implementation | undefined,
  protocolVersion: string | undefined,
): ClientIdentity | undefined {
  if (!info?.name) return undefined;
  return { name: info.name, version: info.version, protocolVersion };
}

function envelopeClientIdentity(ctx: ServerContext | undefined): ClientIdentity | undefined {
  const envelope = requestEnvelope(ctx);
  return toIdentity(envelope?.[CLIENT_INFO_META_KEY], envelope?.[PROTOCOL_VERSION_META_KEY]);
}

function handshakeClientIdentity(source: HandshakeSource): ClientIdentity | undefined {
  return toIdentity(source.getClientVersion(), source.getNegotiatedProtocolVersion());
}

export class ClientMetadata {
  constructor(
    readonly era: ProtocolEra,
    private readonly handshake: HandshakeSource,
  ) {}

  identity(ctx?: ServerContext): ClientIdentity | undefined {
    return this.era === "modern"
      ? envelopeClientIdentity(ctx)
      : handshakeClientIdentity(this.handshake);
  }

  supportsFormElicitation(ctx: ServerContext): boolean {
    const elicitation = this.elicitation(ctx);
    if (elicitation === undefined) return false;
    return elicitation.form !== undefined || elicitation.url === undefined;
  }

  private elicitation(ctx: ServerContext): ElicitationCapability {
    const capabilities =
      this.era === "modern"
        ? requestEnvelope(ctx)?.[CLIENT_CAPABILITIES_META_KEY]
        : this.handshake.getClientCapabilities();
    return capabilities?.elicitation;
  }
}
