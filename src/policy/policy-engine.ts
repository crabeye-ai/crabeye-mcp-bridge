import type { ToolPolicy, ServerBridgeConfig } from "../config/schema.js";
import { escapeMatching } from "../logging/escape.js";
import { escapeLabel } from "../logging/labels.js";

export type PolicyDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "prompt"; message: string };

/** Control, invisible and direction-changing characters a prompt shows as escapes, so the arguments a user approves read as they will run. */
const DECEPTIVE_CHARACTERS = /[\x7f-\x9f\u2028\u2029\u2800\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

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

    const shownArgs = escapeMatching(JSON.stringify(args ?? {}, null, 2), DECEPTIVE_CHARACTERS);
    return { kind: "prompt", message: `Allow ${escapeLabel(`${source}__${toolName}`)} to run?\n\nArguments:\n${shownArgs}` };
  }
}
