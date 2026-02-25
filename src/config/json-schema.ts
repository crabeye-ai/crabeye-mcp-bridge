import { z } from "zod";
import { BridgeConfigSchema } from "./schema.js";

export function generateJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(BridgeConfigSchema) as Record<string, unknown>;
}
