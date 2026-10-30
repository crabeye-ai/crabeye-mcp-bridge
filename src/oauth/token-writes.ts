import type { ConditionalChange, CredentialStore } from "../credentials/credential-store.js";
import type { Credential, OAuth2Credential } from "../credentials/types.js";
import type { Logger } from "../logging/index.js";
import { oauthCredentialKey } from "./client-secret.js";
import { issuerAllows } from "./issuer-binding.js";
import { sameTokens, type TokenPair } from "./repeated-saves.js";

const RECENT_READS_KEPT = 16;

export interface TokenWritesOptions {
  store: CredentialStore;
  serverName: string;
  logger?: Logger;
}

export interface TokenOrigin {
  /** The refresh token whose refresh issued the tokens, if one did. */
  redeemed: string | undefined;
  /** Whether a refresh's tokens may be stored where none are, or only over the tokens it refreshed. */
  addIfMissing: boolean;
}

/**
 * Writes and deletes a provider's tokens in the store without undoing a change
 * made elsewhere:
 * - an issuer stamp on tokens it read only lands on those tokens;
 * - a refresh's result replaces only the tokens it refreshed, so one that
 *   finishes after other tokens were stored is dropped. Given `addIfMissing`,
 *   it also lands where the tokens are missing, since a process whose refresh
 *   of the same token was refused may just have deleted them;
 * - after a refused refresh, only tokens whose refresh token was refused are
 *   deleted, so tokens another process just refreshed are kept.
 */
export class TokenWrites {
  private readonly _recentReads: TokenPair[] = [];
  private readonly _key: string;

  constructor(private readonly _opts: TokenWritesOptions) {
    this._key = oauthCredentialKey(_opts.serverName);
  }

  rememberRead(read: TokenPair): void {
    if (this._recentReads.some((known) => sameTokens(known, read))) return;
    this._recentReads.push(read);
    if (this._recentReads.length > RECENT_READS_KEPT) this._recentReads.shift();
  }

  /** Resolves false only when a refresh's tokens were dropped. */
  async write(credential: OAuth2Credential, { redeemed, addIfMissing }: TokenOrigin): Promise<boolean> {
    if (this._recentReads.some((read) => sameTokens(read, credential))) {
      await this._opts.store.replaceIf(
        this._key,
        credential,
        (stored) => stored.type === "oauth2" && sameTokens(stored, credential) && issuerAllows(stored.issuer, credential.issuer),
      );
      return true;
    }
    if (redeemed === undefined) {
      await this._opts.store.set(this._key, credential);
      return true;
    }
    const refreshedThese = (stored: Credential) => stored.type === "oauth2" && (stored.refresh_token === redeemed || sameTokens(stored, credential));
    if (!addIfMissing) return (await this._opts.store.replaceIf(this._key, credential, refreshedThese)) === "replaced";
    return (await this._opts.store.setIf(this._key, credential, refreshedThese)) !== "kept";
  }

  async delete(): Promise<ConditionalChange<"deleted">> {
    return (await this._opts.store.delete(this._key)) ? "deleted" : "missing";
  }

  /** Deletes the tokens only if their refresh token is one `refused` says the authorization server refused. */
  async deleteRefused(refused: (refreshToken: string | undefined) => boolean): Promise<ConditionalChange<"deleted">> {
    let outcome: ConditionalChange<"deleted">;
    try {
      outcome = await this._opts.store.deleteIf(this._key, (stored) => stored.type !== "oauth2" || refused(stored.refresh_token));
    } catch (err) {
      this._opts.logger?.warn(`could not check the stored tokens for "${this._opts.serverName}"; keeping them`, {
        component: "oauth",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    if (outcome === "kept") {
      this._opts.logger?.info(`kept the tokens for "${this._opts.serverName}" that were refreshed elsewhere`, { component: "oauth" });
    }
    return outcome;
  }
}
