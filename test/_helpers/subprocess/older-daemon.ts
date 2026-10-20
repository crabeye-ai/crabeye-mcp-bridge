import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { encodeFrame, FrameDecoder } from "../../../src/daemon/protocol.js";
import { daemonFilesFor, getDaemonSocketPath } from "../../../src/daemon/paths.js";

const ignoresShutdown = process.argv.includes("--ignore-shutdown");
const relaunchesOnShutdown = process.argv.includes("--relaunch-on-shutdown");

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

function jsonOption(name: string, fallback: unknown): unknown {
  const value = option(name);
  return value === undefined ? fallback : JSON.parse(value);
}

const requestLog = option("--request-log");
if (requestLog === undefined) throw new Error("--request-log is required");
const statusPid = jsonOption("--status-pid-json", process.pid);
const statusUptime = jsonOption("--status-uptime-json", 1);
const statusExtra = jsonOption("--status-extra-json", {}) as Record<string, unknown>;
const statusVersion = option("--status-version");
const statusRefused = jsonOption("--status-refused-json", undefined);
const socketPath = getDaemonSocketPath();
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
rmSync(socketPath, { force: true });
writeFileSync(daemonFilesFor(socketPath).pidPath, `${process.pid}\n`);

function launchSuccessor(): Promise<void> {
  const successor = spawn(process.execPath, process.argv.slice(1), {
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
  });
  successor.unref();
  return new Promise((resolve) => successor.stdout.once("data", () => resolve()));
}

async function shutDown(): Promise<void> {
  if (ignoresShutdown) return;
  if (relaunchesOnShutdown) await launchSuccessor();
  process.exit(0);
}

const server = createServer((socket) => {
  const decoder = new FrameDecoder();
  socket.on("data", (chunk: Buffer) => {
    decoder.push(chunk);
    for (let frame = decoder.next(); frame !== null; frame = decoder.next()) {
      const { id, method } = frame as { id?: string; method?: string };
      if (id === undefined) continue;
      appendFileSync(requestLog, `${String(method)}\n`);
      if (method === "STATUS") {
        const appVersion = statusVersion === undefined ? {} : { appVersion: statusVersion };
        const telemetry = statusRefused === undefined ? {} : { telemetry: { upstreamRequests: { refusedTotal: statusRefused } } };
        socket.write(
          encodeFrame({ id, result: { uptime: statusUptime, pid: statusPid, version: 1, ...appVersion, ...telemetry, ...statusExtra, children: [], sessions: [] } }),
        );
      } else if (method === "SHUTDOWN") {
        socket.write(encodeFrame({ id, result: { ok: true } }));
        setImmediate(() => void shutDown());
      } else {
        socket.write(encodeFrame({ id, error: { code: "unknown_method", message: String(method) } }));
      }
    }
  });
});

server.listen(socketPath, () => process.stdout.write("serving\n"));
