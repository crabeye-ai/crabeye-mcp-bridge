import { readFile } from "node:fs/promises";
import { z } from "zod";
import { BridgeConfigSchema, type BridgeConfig } from "./schema.js";

export interface ConfigIssue {
  path: string;
  message: string;
}

export class ConfigError extends Error {
  readonly issues: ConfigIssue[];

  constructor(message: string, issues: ConfigIssue[] = []) {
    super(message);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

function formatZodIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export interface LoadConfigOptions {
  configPath?: string;
}

export function resolveConfigPath(options?: LoadConfigOptions): string {
  if (options?.configPath) {
    return options.configPath;
  }

  const envPath = process.env.MCP_BRIDGE_CONFIG;
  if (envPath) {
    return envPath;
  }

  throw new ConfigError(
    "No config file specified. Use --config <path> or set MCP_BRIDGE_CONFIG.",
  );
}

export async function loadConfig(
  options?: LoadConfigOptions,
): Promise<BridgeConfig> {
  const configPath = resolveConfigPath(options);

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError(`Config file not found: ${configPath}`);
    }
    throw new ConfigError(
      `Failed to read config file: ${configPath} (${code ?? "unknown error"})`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Invalid JSON in config file: ${configPath}`);
  }

  const result = BridgeConfigSchema.safeParse(json);
  if (!result.success) {
    throw new ConfigError(
      "Config validation failed",
      formatZodIssues(result.error),
    );
  }

  return result.data;
}
