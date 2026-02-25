import {
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  ElicitRequestFormParams,
  ElicitResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolPolicy, ServerBridgeConfig } from "../config/schema.js";

export type ElicitFn = (
  params: ElicitRequestFormParams,
) => Promise<ElicitResult>;

export class PolicyEngine {
  private globalPolicy: ToolPolicy;
  private serverConfigs: Record<string, ServerBridgeConfig>;

  constructor(
    globalPolicy: ToolPolicy,
    serverConfigs: Record<string, ServerBridgeConfig>,
  ) {
    this.globalPolicy = globalPolicy;
    this.serverConfigs = serverConfigs;
  }

  resolvePolicy(source: string, toolName: string): ToolPolicy {
    const serverConfig = this.serverConfigs[source];
    if (serverConfig) {
      const perTool = serverConfig.tools?.[toolName];
      if (perTool) return perTool;

      if (serverConfig.toolPolicy) return serverConfig.toolPolicy;
    }

    return this.globalPolicy;
  }

  async enforce(
    source: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
    elicitFn: ElicitFn,
  ): Promise<void> {
    const policy = this.resolvePolicy(source, toolName);

    if (policy === "always") return;

    if (policy === "never") {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Tool ${source}__${toolName} is disabled by policy`,
      );
    }

    // policy === "prompt"
    try {
      const result = await elicitFn({
        message: `Allow ${source}__${toolName} to run?\n\nArguments:\n${JSON.stringify(args ?? {}, null, 2)}`,
        requestedSchema: { type: "object", properties: {} },
      });

      if (result.action !== "accept") {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Tool ${source}__${toolName} was declined by user`,
        );
      }
    } catch (err) {
      if (err instanceof McpError) throw err;
      // Client doesn't support elicitation — block the call
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Tool ${source}__${toolName} requires confirmation but the client does not support elicitation`,
      );
    }
  }
}
