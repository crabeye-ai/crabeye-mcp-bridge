import { describe, expect, it } from "vitest";
import { currentSearchDescription, type DescriptionLink } from "../../src/upstream/search-description.js";

const HEADER = "Servers (search by provider name):";

function link(state: Partial<{ description: string; isAttached: boolean; isDown: boolean; upstreamNames: string[] }>): DescriptionLink {
  return {
    description: () => state.description,
    isAttached: state.isAttached ?? false,
    isDown: state.isDown ?? false,
    upstreamNames: () => state.upstreamNames ?? [],
  };
}

describe("currentSearchDescription", () => {
  it("lists the bridge's own servers as starting before the link first attaches", () => {
    expect(currentSearchDescription(link({}), ["linear", "github"])).toBe(`${HEADER}\n- linear: starting\n- github: starting`);
  });

  it("lists the bridge's own servers as not connected when the manager can't be reached before the first attach", () => {
    expect(currentSearchDescription(link({ isDown: true }), ["linear"])).toBe(`${HEADER}\n- linear: not connected`);
  });

  it("is the manager's text while attached", () => {
    expect(currentSearchDescription(link({ isAttached: true, description: `${HEADER}\n- linear [issues]` }), ["other"])).toBe(`${HEADER}\n- linear [issues]`);
  });

  it("lists the servers the manager last reported as starting while it is being replaced", () => {
    const interrupted = link({ description: `${HEADER}\n- linear [issues]`, upstreamNames: ["linear", "docs"] });

    expect(currentSearchDescription(interrupted, ["other"])).toBe(`${HEADER}\n- linear: starting\n- docs: starting`);
  });

  it("lists the servers the manager last reported as not connected while it can't be reached", () => {
    const down = link({ description: `${HEADER}\n- linear`, upstreamNames: ["linear"], isDown: true });

    expect(currentSearchDescription(down, ["other"])).toBe(`${HEADER}\n- linear: not connected`);
  });

  it("is empty when there are no servers", () => {
    expect(currentSearchDescription(link({}), [])).toBe("");
    expect(currentSearchDescription(link({ isAttached: true, description: "" }), ["linear"])).toBe("");
  });
});
