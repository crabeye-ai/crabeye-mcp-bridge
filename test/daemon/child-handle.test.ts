import { afterEach, describe, expect, it } from "vitest";
import { ChildHandle } from "../../src/daemon/child-handle.js";
import { processExists } from "../../src/process/process-utils.js";
import { until } from "../_helpers/daemon-fixtures.js";

const IGNORES_SIGTERM = "process.on('SIGTERM', () => {}); process.stdout.write('{\"ready\":true}\\n'); setInterval(() => {}, 1e6)";
const FLOODS_STDOUT = "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1e6)";
const CLOSES_STDOUT = "require('node:fs').closeSync(1); setInterval(() => {}, 1e6)";

describe.skipIf(process.platform === "win32")("ChildHandle", { timeout: 15_000 }, () => {
  const handles: ChildHandle[] = [];

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.kill(0)));
  });

  function spawnChild(script: string, stdoutMaxBytes?: number) {
    const events = { closes: 0, messages: 0 };
    const handle = new ChildHandle({
      command: process.execPath,
      args: ["-e", script],
      env: process.env as Record<string, string>,
      ...(stdoutMaxBytes !== undefined && { stdoutMaxBytes }),
      onMessage: () => events.messages++,
      onClose: () => events.closes++,
      onError: () => {},
    });
    handles.push(handle);
    return { handle, events };
  }

  it("returns the kill already in progress to a second caller and SIGKILLs a SIGTERM-ignoring child", async () => {
    const { handle, events } = spawnChild(IGNORES_SIGTERM);
    await until(() => events.messages > 0);

    const first = handle.kill(300);
    const second = handle.kill(300);

    expect(second).toBe(first);
    await first;
    expect(processExists(handle.pid!)).toBe(false);
  });

  it("reports a child it killed for flooding stdout through onClose, once", async () => {
    const { events } = spawnChild(FLOODS_STDOUT, 1_024);

    await until(() => events.closes > 0);
    await new Promise((r) => setTimeout(r, 200));

    expect(events.closes).toBe(1);
  });

  it("still signals a child whose stdout closed while it kept running", async () => {
    const { handle, events } = spawnChild(CLOSES_STDOUT);
    await until(() => events.closes > 0);
    expect(processExists(handle.pid!)).toBe(true);

    await handle.kill(300);

    expect(processExists(handle.pid!)).toBe(false);
  });
});
