import { describe, expect, it } from "vitest";
import type { UpstreamSnapshot } from "../../src/daemon/protocol.js";
import { InstanceUpstreamClient } from "../../src/upstream/instance-upstream-client.js";
import type { StatusChangeEvent } from "../../src/upstream/types.js";
import { FakeInstanceLink } from "../_helpers/fake-instance-link.js";
import { tool } from "../_helpers/scripted-upstream-client.js";

const connected = (overrides: Partial<UpstreamSnapshot> = {}): UpstreamSnapshot => ({
  name: "svc",
  status: "connected",
  tools: [tool("search")],
  instructions: "use search",
  ...overrides,
});

function standIn(link = new FakeInstanceLink()): { link: FakeInstanceLink; client: InstanceUpstreamClient; events: StatusChangeEvent[]; toolEvents: number[] } {
  link.retry.mockImplementation(async (name) => {
    const snapshot = link.snapshots.get(name) ?? connected();
    link.send(snapshot.status === "connected" ? snapshot : connected());
    return link.snapshots.get(name)!;
  });
  const client = new InstanceUpstreamClient({ name: "svc", link: link });
  const events: StatusChangeEvent[] = [];
  const toolEvents: number[] = [];
  client.onStatusChange((event) => events.push(event));
  client.onToolsChanged((tools) => toolEvents.push(tools.length));
  return { link, client, events, toolEvents };
}

describe("InstanceUpstreamClient", () => {
  describe("connect", () => {
    it("uses the snapshot the link already has when the upstream is connected", async () => {
      const { link, client, toolEvents } = standIn();
      link.snapshots.set("svc", connected());

      await client.connect();

      expect(client.status).toBe("connected");
      expect(client.tools).toEqual([tool("search")]);
      expect(client.instructions).toBe("use search");
      expect(toolEvents).toEqual([1]);
      expect(link.retry).not.toHaveBeenCalled();
    });

    it("asks the daemon to try an upstream that isn't connected, and settles on the outcome", async () => {
      const { link, client, events } = standIn();
      link.snapshots.set("svc", { name: "svc", status: "disconnected", error: "reset", tools: [] });

      await client.connect();

      expect(link.retry).toHaveBeenCalledWith("svc");
      expect(events.map((e) => e.current)).toEqual(["connecting", "connected"]);
    });

    it("rejects with the reason when the daemon's attempt fails, keeping the state it reported", async () => {
      const { link, client } = standIn();
      link.retry.mockImplementation(async () => {
        const snapshot: UpstreamSnapshot = { name: "svc", status: "auth_required", error: "invalid_grant", tools: [] };
        link.send(snapshot);
        return snapshot;
      });

      await expect(client.connect()).rejects.toThrow("invalid_grant");
      expect(client.status).toBe("auth_required");
    });

    it("waits for the outcome when the daemon reports the upstream still connecting", async () => {
      const { link, client } = standIn();
      link.retry.mockImplementation(async () => {
        const snapshot: UpstreamSnapshot = { name: "svc", status: "connecting", tools: [] };
        link.send(snapshot);
        setTimeout(() => link.send(connected()), 10);
        return snapshot;
      });

      await client.connect();
      expect(client.status).toBe("connected");
    });

    it("rejects with the daemon error when the link can't attach", async () => {
      const { link, client } = standIn();
      link.attach.mockRejectedValue(new Error("daemon did not become reachable within timeout"));

      await expect(client.connect()).rejects.toThrow("daemon did not become reachable within timeout");
      expect(link.retry).not.toHaveBeenCalled();
    });

    it("rejects with the daemon's refusal of the upstream, and shows it disconnected", async () => {
      const { link, client, events } = standIn();
      link.retry.mockRejectedValue(new Error('"svc" is not in the configuration the manager loaded'));

      await expect(client.connect()).rejects.toThrow("not in the configuration");
      expect(client.status).toBe("disconnected");
      expect(events.at(-1)?.error?.message).toContain("not in the configuration");
    });
  });

  describe("retryNow", () => {
    it("switches to connecting at once, so a waiting call sees an attempt, then takes the daemon's answer", async () => {
      const { link, client, events } = standIn();
      link.send({ name: "svc", status: "auth_required", error: "expired", tools: [] });
      let answer!: (snapshot: UpstreamSnapshot) => void;
      link.retry.mockImplementation(() => new Promise((resolve) => (answer = resolve)));

      const retrying = client.retryNow();
      expect(client.status).toBe("connecting");
      link.send(connected());
      answer(connected());
      await retrying;

      expect(events.map((e) => e.current)).toEqual(["auth_required", "connecting", "connected"]);
    });

    it("does nothing for a connected upstream", async () => {
      const { link, client } = standIn();
      link.send(connected());
      await client.retryNow();
      expect(link.retry).not.toHaveBeenCalled();
    });

    it("attaches the link first when it is down, and stops there when that fails", async () => {
      const { link, client } = standIn();
      link.isAttached = false;
      link.attachNow.mockImplementation(async () => {
        link.isAttached = true;
      });
      await client.retryNow();
      expect(link.attachNow).toHaveBeenCalled();
      expect(link.retry).toHaveBeenCalled();

      link.isAttached = false;
      link.retry.mockClear();
      link.attachNow.mockRejectedValue(new Error("still down"));
      await client.retryNow();
      expect(link.retry).not.toHaveBeenCalled();
    });

    it("leaves an upstream alone that connected while the link was attaching again", async () => {
      const { link, client, events } = standIn();
      link.send({ name: "svc", status: "connecting", tools: [] });
      link.isAttached = false;
      link.attachNow.mockImplementation(async () => {
        link.isAttached = true;
        link.send(connected());
      });

      await client.retryNow();

      expect(client.status).toBe("connected");
      expect(link.retry).not.toHaveBeenCalled();
      expect(events.map((e) => e.current)).toEqual(["connecting", "connected"]);
    });

    it("is what reconnect does, so a bridge never replaces the shared connection", async () => {
      const { link, client } = standIn();
      link.send({ name: "svc", status: "disconnected", tools: [] });
      await client.reconnect();
      expect(link.retry).toHaveBeenCalledTimes(1);
    });
  });

  describe("callTool", () => {
    it("refuses while not connected, as a direct client does", async () => {
      const { client } = standIn();
      await expect(client.callTool({ name: "search" })).rejects.toThrow('Cannot call tool "search": client "svc" is not connected');
    });

    it("sends the call through the link with the caller's signal", async () => {
      const { link, client } = standIn();
      link.send(connected());
      const signal = new AbortController().signal;

      expect(await client.callTool({ name: "search", arguments: { q: "x" } }, { signal })).toEqual({ content: [{ type: "text", text: "ok" }] });
      expect(link.callTool).toHaveBeenCalledWith("svc", { name: "search", arguments: { q: "x" } }, signal);
    });
  });

  describe("following the link", () => {
    it("shows connecting while the daemon is replaced, the error while it is down, and the removal of its upstream", () => {
      const { link, client, events } = standIn();
      link.send(connected());
      const [view] = link.viewsOf("svc");

      view!.onInterrupted();
      expect(client.status).toBe("connecting");
      view!.onDown(new Error("daemon unreachable"));
      expect(events.at(-1)).toMatchObject({ current: "disconnected", error: new Error("daemon unreachable") });
      link.send(connected());
      view!.onRemoved();
      expect(events.at(-1)?.error?.message).toBe('"svc" is not in the configuration the manager loaded');
    });

    it("reports tools again on each connect and whenever they change, not on every state change", () => {
      const { link, toolEvents } = standIn();
      link.send(connected());
      link.send(connected());
      link.send(connected({ tools: [tool("search"), tool("fetch")] }));
      link.send({ name: "svc", status: "disconnected", tools: [tool("search"), tool("fetch")] });
      link.send(connected({ tools: [tool("search"), tool("fetch")] }));

      expect(toolEvents).toEqual([1, 2, 2]);
    });

    it("keeps its tools while the upstream reconnects, as a direct client does", () => {
      const { link, client, toolEvents } = standIn();
      link.send(connected());
      link.send({ name: "svc", status: "connecting", tools: [] });

      expect(client.tools).toEqual([tool("search")]);
      link.send(connected());
      expect(toolEvents).toEqual([1, 1]);
    });

    it("reports a failure's reason with the state change", () => {
      const { link, events } = standIn();
      link.send({ name: "svc", status: "disconnected", error: "ECONNREFUSED", tools: [] });
      expect(events).toEqual([]);
      link.send({ name: "svc", status: "connecting", tools: [] });
      link.send({ name: "svc", status: "disconnected", error: "ECONNREFUSED", tools: [] });
      expect(events.at(-1)?.error?.message).toBe("ECONNREFUSED");
    });
  });

  it("answers pings from the state the daemon reports", async () => {
    const { link, client } = standIn();
    await expect(client.ping()).rejects.toThrow("not connected");
    link.send(connected());
    await expect(client.ping()).resolves.toBeUndefined();
  });

  it("stops following the link once closed", async () => {
    const { link, client } = standIn();
    link.send(connected());
    await client.close();

    expect(client.status).toBe("disconnected");
    expect(client.tools).toEqual([]);
    expect(link.viewsOf("svc")).toEqual([]);
    await expect(client.connect()).rejects.toThrow("closed");
  });
});
