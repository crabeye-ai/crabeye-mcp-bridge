import type { ElicitRequestFormParams } from "@modelcontextprotocol/server";
import type { ToolPolicy, ServerBridgeConfig } from "../config/schema.js";

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "prompt"; request: ElicitRequestFormParams };

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

  update(
    globalPolicy: ToolPolicy,
    serverConfigs: Record<string, ServerBridgeConfig>,
  ): void {
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

  evaluate(
    source: string,
    toolName: string,
    args: Record<string, unknown> | undefined,
  ): PolicyDecision {
    const policy = this.resolvePolicy(source, toolName);

    if (policy === "always") return { kind: "allow" };

    if (policy === "never") {
      return {
        kind: "deny",
        reason: `Tool ${source}__${toolName} is disabled by policy`,
      };
    }

    // policy === "prompt"
    return {
      kind: "prompt",
      request: {
        message: `Allow ${source}__${toolName} to run?\n\nArguments:\n${JSON.stringify(args ?? {}, null, 2)}`,
        requestedSchema: { type: "object", properties: {} },
      },
    };
  }
}
