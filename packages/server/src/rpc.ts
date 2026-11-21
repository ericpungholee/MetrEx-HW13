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

/**
 * Client-side request pacing. Hosted RPC tiers cap requests per second; going over earns HTTP 429
 * and web3.js backs off for 0.5–8 s, which is far slower than waiting our turn. Each HTTP request
 * (a JSON-RPC batch counts once) waits for the next free slot of `1000 / maxRps` ms.
 */
export class RequestPacer {
  private next = 0;
  /** HTTP requests sent, by JSON-RPC method. */
  readonly counts = new Map<string, number>();
  total = 0;

  constructor(
    readonly maxRps: number | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.windowStart = this.now();
  }

  /** ms to wait before the next request may go out; reserves that slot. */
  reserve(): number {
    if (!this.maxRps || this.maxRps <= 0) return 0;
    const t = this.now();
    const at = Math.max(t, this.next);
    this.next = at + 1000 / this.maxRps;
    return at - t;
  }

  /** Counts one request; returns its JSON-RPC method ("batch:<first>" for a batch). */
  record(body: unknown): string {
    this.total++;
    let method = "?";
    try {
      const parsed = typeof body === "string" ? (JSON.parse(body) as { method?: string } | { method?: string }[]) : null;
      method = (Array.isArray(parsed) ? `batch:${parsed[0]?.method ?? "?"}` : parsed?.method) ?? "?";
    } catch {
      /* non-JSON body */
    }
    this.counts.set(method, (this.counts.get(method) ?? 0) + 1);
    return method;
  }

  private windowStart: number;
  private windowTotal = 0;

  /** "N req in S s (R/s): method n, …" since the last call, busiest methods first; resets the window. */
  report(): string {
    const secs = Math.max(1, (this.now() - this.windowStart) / 1000);
    const n = this.total - this.windowTotal;
    const top = [...this.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([m, c]) => `${m} ${c}`).join(", ");
    this.windowStart = this.now();
    this.windowTotal = this.total;
    this.counts.clear();
    return `${n} req in ${secs.toFixed(0)} s (${(n / secs).toFixed(1)}/s${this.maxRps ? `, cap ${this.maxRps}/s` : ""}): ${top}`;
  }
}

export class RpcPool {
  readonly endpoints: readonly Connection[];
  readonly pacer: RequestPacer;
  /** Separate, lower cap for getProgramAccounts, which hosted tiers limit far below other reads. */
  readonly scanPacer: RequestPacer;
  private active = 0;

  constructor(urls: readonly string[], commitment: Commitment = DEFAULT_COMMITMENT, opts: { maxRps?: number; maxScanRps?: number } = {}) {
    if (urls.length === 0) throw new Error("RpcPool needs at least one URL");
    const pacer = new RequestPacer(opts.maxRps);
    const scanPacer = new RequestPacer(opts.maxScanRps);
    this.pacer = pacer;
    this.scanPacer = scanPacer;
    this.endpoints = urls.map(
      (u) =>
        new Connection(u, {
          commitment,
          fetchMiddleware: (info, init, fetch) => {
            const isScan = pacer.record(init?.body) === "getProgramAccounts";
            const wait = Math.max(pacer.reserve(), isScan ? scanPacer.reserve() : 0);
            if (wait > 0) setTimeout(() => fetch(info, init), wait);
            else fetch(info, init);
          },
        }),
    );
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

/** Pool from `RPC_URL` (+ optional `RPC_URL_BACKUP`), paced by `RPC_MAX_RPS` and `RPC_MAX_SCAN_RPS` when set. */
export function getRpc(): RpcPool {
  if (!defaultPool) {
    const urls = [envOrUndefined("RPC_URL") ?? DEFAULT_RPC_URL];
    const backup = envOrUndefined("RPC_URL_BACKUP");
    if (backup && backup !== urls[0]) urls.push(backup);
    const num = (name: string): number | undefined => {
      const v = Number(envOrUndefined(name) ?? 0);
      return Number.isFinite(v) && v > 0 ? v : undefined;
    };
    defaultPool = new RpcPool(urls, DEFAULT_COMMITMENT, { maxRps: num("RPC_MAX_RPS"), maxScanRps: num("RPC_MAX_SCAN_RPS") });
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
