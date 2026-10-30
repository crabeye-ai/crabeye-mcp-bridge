export interface TokenPair {
  access_token: string;
  refresh_token?: string;
}

/** What decides whether a save repeats the last one. */
export interface SavedTokens extends TokenPair {
  issuer?: string;
}

export function sameTokens(a: TokenPair, b: TokenPair): boolean {
  return a.access_token === b.access_token && a.refresh_token === b.refresh_token;
}

/**
 * Every 401 that shared one refresh saves its result again. Remembers the
 * last tokens a provider stored so those repeats wait for that write instead
 * of writing again; a write that failed is forgotten, so the next save writes.
 */
export class RepeatedSaves {
  private _last: { tokens: SavedTokens; stored: Promise<void> } | undefined;

  /** Writes `tokens` unless they repeat the last ones, then waits for that write; true when it wrote. */
  async saveOnce(tokens: SavedTokens, write: () => Promise<void>): Promise<boolean> {
    const last = this._last;
    if (last !== undefined && sameTokens(last.tokens, tokens) && last.tokens.issuer === tokens.issuer) {
      await last.stored;
      return false;
    }
    const entry = { tokens, stored: write() };
    this._last = entry;
    try {
      await entry.stored;
      return true;
    } catch (err) {
      if (this._last === entry) this._last = last;
      throw err;
    }
  }
}
