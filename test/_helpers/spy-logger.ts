import { vi, type Mock } from "vitest";
import type { Logger } from "../../src/logging/index.js";

export interface SpyLogger extends Logger {
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
}

export function spyLogger(): SpyLogger {
  const logger: SpyLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
  };
  return logger;
}
