// RPC connections with a backup endpoint (spec §14: "Backup RPC endpoint configured").
// `rpc.run(fn)` runs `fn` on the active connection; on a transport-level failure it
// switches to the other endpoint (sticky) and retries once.

import { Connection, type Commitment } from "@solana/web3.js";
import { envOrUndefined } from "./env";

export const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
export const DEFAULT_COMMITMENT: Commitment = "confirmed";

/** Errors that mean "this endpoint is unhealthy", not "the request was wrong". */
export function isTransportError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|network|timed? ?out|429|Too Many Requests|50[0-9] |Bad Gateway|Service Unavailable|Gateway Timeout/i.test(
    msg,
  );
}

export class RpcPool {
  readonly endpoints: readonly Connection[];
  private active = 0;

  constructor(urls: readonly string[], commitment: Commitment = DEFAULT_COMMITMENT) {
    if (urls.length === 0) throw new Error("RpcPool needs at least one URL");
    this.endpoints = urls.map((u) => new Connection(u, { commitment }));
  }

  /** Current connection (use `run` for automatic failover). */
  get connection(): Connection {
    const c = this.endpoints[this.active];
    if (!c) throw new Error("no RPC endpoint");
    return c;
  }

  get endpointUrl(): string {
    return this.connection.rpcEndpoint;
  }

  /**
   * For reads only. Never wrap a transaction send in `run`: a transport error after the
   * send may hide a landed transaction, and the retry would send a second one.
   */
  async run<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    const first = this.active;
    try {
      return await fn(this.connection);
    } catch (e) {
      if (this.endpoints.length < 2 || !isTransportError(e)) throw e;
      this.active = (first + 1) % this.endpoints.length;
      return await fn(this.connection);
    }
  }
}

let defaultPool: RpcPool | undefined;

/** Pool from `RPC_URL` (+ optional `RPC_URL_BACKUP`). */
export function getRpc(): RpcPool {
  if (!defaultPool) {
    const urls = [envOrUndefined("RPC_URL") ?? DEFAULT_RPC_URL];
    const backup = envOrUndefined("RPC_URL_BACKUP");
    if (backup && backup !== urls[0]) urls.push(backup);
    defaultPool = new RpcPool(urls);
  }
  return defaultPool;
}

/** Strips any API key from an RPC URL before logging it. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : "/…"}`;
  } catch {
    return "<rpc>";
  }
}
