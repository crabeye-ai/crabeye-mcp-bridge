/** The shortest time between two announcements that the tool list changed. */
export const LIST_CHANGE_INTERVAL_MS = 1_000;

export interface ListChangeAnnouncerOptions {
  /** The text the tool list carries now. */
  current: () => string;
  /** Tells the client its tool list changed. */
  announce: () => void;
  intervalMs?: number;
}

/**
 * Tells the client its tool list changed at most once per interval, and only
 * when the text differs from what the client was last told or served.
 */
export class ListChangeAnnouncer {
  private readonly _opts: ListChangeAnnouncerOptions;
  private _known: string;
  private _timer: NodeJS.Timeout | undefined;
  private _closed = false;

  constructor(opts: ListChangeAnnouncerOptions) {
    this._opts = opts;
    this._known = opts.current();
  }

  /** The client was just given `text`. */
  served(text: string): void {
    this._known = text;
  }

  changed(): void {
    if (this._closed || this._timer !== undefined) return;
    this._timer = setTimeout(() => {
      this._timer = undefined;
      const text = this._opts.current();
      if (this._closed || text === this._known) return;
      this._known = text;
      this._opts.announce();
    }, this._opts.intervalMs ?? LIST_CHANGE_INTERVAL_MS);
    this._timer.unref();
  }

  close(): void {
    this._closed = true;
    clearTimeout(this._timer);
    this._timer = undefined;
  }
}
