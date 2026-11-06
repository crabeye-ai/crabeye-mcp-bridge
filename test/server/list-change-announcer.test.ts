import { afterEach, describe, expect, it, vi } from "vitest";
import { ListChangeAnnouncer } from "../../src/server/list-change-announcer.js";

describe("ListChangeAnnouncer", () => {
  let text = "a";
  let announced = 0;
  let announcer: ListChangeAnnouncer | undefined;

  afterEach(() => {
    announcer?.close();
    vi.useRealTimers();
  });

  function start(): ListChangeAnnouncer {
    vi.useFakeTimers();
    text = "a";
    announced = 0;
    announcer = new ListChangeAnnouncer({ current: () => text, announce: () => announced++, intervalMs: 1_000 });
    return announcer;
  }

  it("announces changes within an interval once, at its end", () => {
    const changes = start();

    text = "b";
    changes.changed();
    text = "c";
    changes.changed();
    vi.advanceTimersByTime(999);
    expect(announced).toBe(0);
    vi.advanceTimersByTime(1);

    expect(announced).toBe(1);
  });

  it("announces at most once per interval while changes keep coming", () => {
    const changes = start();

    for (let step = 0; step < 50; step++) {
      text = `t${step}`;
      changes.changed();
      vi.advanceTimersByTime(100);
    }

    expect(announced).toBe(5);
  });

  it("announces nothing when the text is back to what the client was last told", () => {
    const changes = start();

    text = "b";
    changes.changed();
    text = "a";
    vi.advanceTimersByTime(1_000);

    expect(announced).toBe(0);
  });

  it("announces nothing when the client already fetched the new text", () => {
    const changes = start();

    text = "b";
    changes.changed();
    changes.served("b");
    vi.advanceTimersByTime(1_000);

    expect(announced).toBe(0);
  });

  it("announces a change after the client was served an older text", () => {
    const changes = start();
    changes.served("a");

    text = "b";
    changes.changed();
    vi.advanceTimersByTime(1_000);

    expect(announced).toBe(1);
  });

  it("announces nothing once closed", () => {
    const changes = start();

    text = "b";
    changes.changed();
    changes.close();
    changes.changed();
    vi.advanceTimersByTime(5_000);

    expect(announced).toBe(0);
  });
});
