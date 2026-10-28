import { DAEMON_SHUTDOWN_MARGIN_MS } from "../constants.js";
import type { Logger } from "../logging/index.js";

const MAX_TIMER_MS = 2_147_483_647;
const CRASH_EVENTS = ["uncaughtException", "unhandledRejection"] as const;
const STOP_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export interface Stoppable {
  stop(exitCode: number, reason: string): Promise<void>;
}

export interface CrashHandlerOptions {
  logger: Logger;
  target: Stoppable;
  watchdogMs: number;
  exit?: (code: number) => void;
}

export function daemonStopBudgetMs(killGraceMs: number): number {
  return Math.min(2 * killGraceMs + DAEMON_SHUTDOWN_MARGIN_MS, MAX_TIMER_MS);
}

export function installCrashHandlers(opts: CrashHandlerOptions): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.logger.child({ component: "daemon" });
  let crashed = false;
  const listeners = CRASH_EVENTS.map((event) => {
    const listener = (err: unknown): void => {
      log.error(`${event}: ${stackOrMessage(err)}`);
      if (crashed) {
        exit(1);
        return;
      }
      crashed = true;
      setTimeout(() => exit(1), opts.watchdogMs).unref();
      opts.target.stop(1, `crashed: ${errMsg(err)}`).catch((stopErr: unknown) => {
        log.error(`stop failed after a crash: ${stackOrMessage(stopErr)}`);
        exit(1);
      });
    };
    process.on(event, listener);
    return [event, listener] as const;
  });
  return () => {
    for (const [event, listener] of listeners) process.off(event, listener);
  };
}

export function installSignalHandlers(target: Stoppable): () => void {
  const uninstall = (): void => {
    for (const signal of STOP_SIGNALS) process.off(signal, onSignal);
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    uninstall();
    void target.stop(0, `signal ${signal}`);
  };
  for (const signal of STOP_SIGNALS) process.on(signal, onSignal);
  return uninstall;
}

function stackOrMessage(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
