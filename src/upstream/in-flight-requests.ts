import type { Client } from "@modelcontextprotocol/client";

/** Counts each client's requests in flight. A retired client stays open until its last request settles. */
export class InFlightRequests {
  private readonly _counts = new Map<Client, number>();
  private readonly _retired = new Set<Client>();

  async send<T>(client: Client, request: (client: Client) => Promise<T>): Promise<T> {
    this._counts.set(client, (this._counts.get(client) ?? 0) + 1);
    try {
      return await request(client);
    } finally {
      this._settle(client);
    }
  }

  /** Closes `client` now if nothing is in flight on it, or else once its last request settles. */
  retire(client: Client): void {
    if (this._counts.has(client)) this._retired.add(client);
    else void client.close().catch(() => {});
  }

  /** Closes every retired client still waiting for its requests. */
  async closeRetired(): Promise<void> {
    const retired = [...this._retired];
    this._retired.clear();
    await Promise.all(retired.map((client) => client.close().catch(() => {})));
  }

  private _settle(client: Client): void {
    const left = (this._counts.get(client) ?? 1) - 1;
    if (left > 0) return void this._counts.set(client, left);
    this._counts.delete(client);
    if (this._retired.delete(client)) void client.close().catch(() => {});
  }
}
