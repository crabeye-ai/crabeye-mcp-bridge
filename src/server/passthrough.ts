import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  PassthroughLevel,
  ServerConfig,
  ToolPolicy,
} from "../config/schema.js";
import { NAMESPACE_SEPARATOR } from "./tool-namespacing.js";

export const TRUNCATION_MARKER = "\n…(truncated)";

/**
 * Hard ceiling on the rendered block size, applied even when the user did
 * not set `_bridge.passthroughMaxBytes`. A misbehaving upstream returning a
 * multi-MiB `instructions` string would otherwise be re-allocated on every
 * regenerate and shipped to every connecting client.
 */
const HARD_CAP_BYTES = 256 * 1024;

export interface PassthroughDeps {
  upstreams: Record<string, ServerConfig>;
  getInstructions: (configKey: string) => string | undefined;
  getTools: (configKey: string) => ReadonlyArray<Tool>;
  resolvePolicy: (configKey: string, toolName: string) => ToolPolicy;
}

export function renderPassthrough(deps: PassthroughDeps): string {
  const blocks: string[] = [];
  for (const [configKey, cfg] of Object.entries(deps.upstreams)) {
    const level = cfg._bridge?.passthrough;
    if (level === undefined || level === false) continue;
    const block = renderBlock(
      configKey,
      level,
      deps,
      cfg._bridge?.passthroughMaxBytes,
    );
    if (block !== null) blocks.push(block);
  }
  return blocks.join("\n\n");
}

function renderBlock(
  configKey: string,
  level: Exclude<PassthroughLevel, false>,
  deps: PassthroughDeps,
  maxBytes: number | undefined,
): string | null {
  const rawInstructions = deps.getInstructions(configKey);
  const instructions =
    typeof rawInstructions === "string" ? sanitize(rawInstructions) : undefined;
  const hasInstructions = instructions !== undefined && instructions !== "";

  const effectiveMax = Math.min(maxBytes ?? HARD_CAP_BYTES, HARD_CAP_BYTES);

  if (level === "instructions") {
    if (!hasInstructions) return null;
    return capBytes(`## ${configKey}\n\n${instructions}`, effectiveMax);
  }

  const tools = deps.getTools(configKey).filter((t) => {
    const bare = stripNamespace(configKey, t.name);
    return deps.resolvePolicy(configKey, bare) !== "never";
  });

  const lines: string[] = [`## ${configKey}`, ""];
  if (hasInstructions) {
    lines.push(instructions, "");
  }
  lines.push("### Tools", "");
  for (const tool of tools) {
    const desc = sanitize(tool.description ?? "");
    const safeName = sanitize(tool.name);
    const suffix = desc.length > 0 ? ` — ${desc}` : "";
    lines.push(`- ${safeName}${suffix}`);
    if (level === "full") {
      lines.push(`    inputSchema: ${safeStringify(tool.inputSchema)}`);
    }
  }
  return capBytes(lines.join("\n"), effectiveMax);
}

function stripNamespace(configKey: string, namespacedName: string): string {
  const prefix = `${configKey}${NAMESPACE_SEPARATOR}`;
  return namespacedName.startsWith(prefix)
    ? namespacedName.slice(prefix.length)
    : namespacedName;
}

/**
 * Strip C0/C1 control chars (except \n and \t), Unicode bidi overrides, and
 * zero-width/format chars from upstream-supplied text before it lands in the
 * LLM's system prompt. Defends against an upstream injecting RTL overrides
 * or hidden payloads that render invisibly to a human auditing logs but
 * still influence the LLM tokenizer.
 */
const UNSAFE_CHARS_RE = new RegExp(
  "[" +
    "\\u0000-\\u0008" +
    "\\u000B-\\u001F" + // C0 controls minus \n (\\u000A) and \\t (\\u0009)
    "\\u007F-\\u009F" + // DEL + C1 controls
    "\\u200B-\\u200F" + // zero-width + LRM/RLM
    "\\u2028-\\u202E" + // line/paragraph sep + bidi overrides
    "\\u2066-\\u2069" + // bidi isolates
    "\\uFEFF" + // BOM / zero-width no-break space
    "]",
  "g",
);

function sanitize(s: string): string {
  return s.replace(UNSAFE_CHARS_RE, "");
}

/**
 * `JSON.stringify` throws on `BigInt` and circular references. The MCP SDK's
 * zod parse rejects circular `inputSchema` shapes, but a hostile upstream
 * could still slip a `BigInt` through `passthrough()`-ed properties. Convert
 * BigInt to decimal-string form and fall back to `"[unserializable]"` on
 * anything else — a render-time crash here would otherwise propagate out of
 * `BridgeServer` construction and abort startup.
 */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, val) =>
      typeof val === "bigint" ? val.toString() : val,
    );
  } catch {
    return '"[unserializable]"';
  }
}

function capBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf-8");
  if (buf.byteLength <= maxBytes) return s;
  let cut = maxBytes;
  // `subarray(0, cut)` excludes `buf[cut]`. Walk back while `buf[cut]` is a
  // UTF-8 continuation byte (10xxxxxx) so we don't slice in the middle of a
  // multi-byte codepoint. ASCII (0xxxxxxx) and lead bytes (11xxxxxx) sit at
  // the START of a codepoint and therefore at the END of the slice — both
  // are valid stop positions.
  while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
  return buf.subarray(0, cut).toString("utf-8") + TRUNCATION_MARKER;
}
