import { zodToJsonSchema } from "zod-to-json-schema";
import { BridgeConfigSchema } from "./schema.js";

export function generateJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(BridgeConfigSchema, "BridgeConfig") as Record<
    string,
    unknown
  >;
}
