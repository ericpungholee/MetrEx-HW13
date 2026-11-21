// Network panel stats (spec §10.5): program transactions (total, last 10 min) and total network
// fees in SOL from transaction metadata. getSignaturesForAddress(programId) paging +
// batched getTransaction, cached in memory. No database.

import type { Connection, PublicKey } from "@solana/web3.js";
import { formatSol } from "../token";

export interface TxSample {
  signature: string;
  /** Unix seconds; null if the RPC didn't report one. */
  blockTime: number | null;
  /** Lamports from meta.fee; null until fetched. */
  fee: bigint | null;
  failed: boolean;
}

export interface ProgramStats {
  programId: string;
  totalTransactions: number;
  last10Minutes: number;
  failedTransactions: number;
  totalFeesLamports: string;
  totalFeesSol: string;
  /** Transactions whose fee is not yet fetched (excluded from the fee total). */
  feesPending: number;
  /** True if history was longer than the backfill cap, so totals are a lower bound. */
  truncated: boolean;
  /** True if the last refresh failed and these are cached numbers. */
  stale: boolean;
  updatedAt: string;
}

export const TEN_MINUTES_S = 600;

/** Pure aggregation over cached samples. */
export function aggregateStats(
  samples: Iterable<TxSample>,
  nowSec: number,
): Pick<ProgramStats, "totalTransactions" | "last10Minutes" | "failedTransactions" | "totalFeesLamports" | "totalFeesSol" | "feesPending"> {
  let total = 0;
  let recent = 0;
  let failed = 0;
  let pending = 0;
  let fees = 0n;
  const cutoff = nowSec - TEN_MINUTES_S;
  for (const s of samples) {
    total++;
    if (s.failed) failed++;
    if (s.blockTime !== null && s.blockTime >= cutoff) recent++;
    if (s.fee === null) pending++;
    else fees += s.fee;
  }
  return {
    totalTransactions: total,
    last10Minutes: recent,
    failedTransactions: failed,
    totalFeesLamports: fees.toString(),
    totalFeesSol: formatSol(fees),
    feesPending: pending,
  };
}

export interface SignatureRow {
  signature: string;
  blockTime: number | null;
  failed: boolean;
}

/** The two RPC calls the indexer needs (injectable for tests). */
export interface StatsSource {
  /** Newest-first, like getSignaturesForAddress. */
  signatures(opts: { before?: string; until?: string; limit: number }): Promise<SignatureRow[]>;
  /** Fee per signature (same order); null if the transaction isn't available yet. */
  fees(signatures: string[]): Promise<(bigint | null)[]>;
}

export function connectionSource(getConn: () => Connection, programId: PublicKey): StatsSource {
  return {
    async signatures(opts) {
      const rows = await getConn().getSignaturesForAddress(programId, opts, "confirmed");
      return rows.map((r) => ({ signature: r.signature, blockTime: r.blockTime ?? null, failed: r.err !== null }));
    },
    async fees(sigs) {
      const txs = await getConn().getTransactions(sigs, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      return txs.map((t) => (t?.meta ? BigInt(t.meta.fee) : null));
    },
  };
}

export interface IndexerOptions {
  pageSize?: number;
  /** Max signatures kept from history on the first scan. */
  maxBackfill?: number;
  /** Fee lookups per refresh (the rest are filled in on later refreshes). */
  feeBatchesPerRefresh?: number;
  feeBatchSize?: number;
  /** Minimum time between refreshes; getStats() inside it returns the cache. */
  minIntervalMs?: number;
  now?: () => number;
}

export class ProgramIndexer {
  private readonly samples = new Map<string, TxSample>();
  /** Newest-first order of signatures. */
  private order: string[] = [];
  private truncated = false;
  private lastRefresh: number | undefined;
  private stale = false;
  private inflight: Promise<void> | undefined;
  private readonly o: Required<IndexerOptions>;

  constructor(
    private readonly programId: string,
    private readonly source: StatsSource,
    opts: IndexerOptions = {},
  ) {
    this.o = {
      pageSize: opts.pageSize ?? 1000,
      maxBackfill: opts.maxBackfill ?? 20_000,
      feeBatchesPerRefresh: opts.feeBatchesPerRefresh ?? 10,
      feeBatchSize: opts.feeBatchSize ?? 25,
      minIntervalMs: opts.minIntervalMs ?? 5_000,
      now: opts.now ?? Date.now,
    };
  }

  /** Pulls new signatures (newest-first, paging with `before`) and some missing fees. */
  async refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.doRefresh().finally(() => {
        this.inflight = undefined;
      });
    }
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    const until = this.order[0];
    const fresh: SignatureRow[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.source.signatures({ before, until, limit: this.o.pageSize });
      fresh.push(...page);
      if (page.length < this.o.pageSize) break;
      if (!until && fresh.length >= this.o.maxBackfill) {
        this.truncated = true;
        break;
      }
      before = page[page.length - 1]?.signature;
    }
    const newOrder: string[] = [];
    for (const r of fresh) {
      if (this.samples.has(r.signature)) continue;
      this.samples.set(r.signature, { signature: r.signature, blockTime: r.blockTime, fee: null, failed: r.failed });
      newOrder.push(r.signature);
    }
    this.order = [...newOrder, ...this.order];

    const missing = this.order.filter((s) => this.samples.get(s)?.fee === null);
    const limit = this.o.feeBatchesPerRefresh * this.o.feeBatchSize;
    const todo = missing.slice(0, limit);
    for (let i = 0; i < todo.length; i += this.o.feeBatchSize) {
      const batch = todo.slice(i, i + this.o.feeBatchSize);
      const fees = await this.source.fees(batch);
      batch.forEach((sig, j) => {
        const s = this.samples.get(sig);
        const f = fees[j];
        if (s && f !== undefined && f !== null) s.fee = f;
      });
    }
    this.lastRefresh = this.o.now();
  }

  /** Cached stats, refreshing first if older than `minIntervalMs`. Never throws once warm. */
  async getStats(): Promise<ProgramStats> {
    const now = this.o.now();
    if (this.lastRefresh === undefined || now - this.lastRefresh >= this.o.minIntervalMs) {
      try {
        await this.refresh();
        this.stale = false;
      } catch (e) {
        if (this.lastRefresh === undefined) throw e;
        this.stale = true;
      }
    }
    return this.snapshot();
  }

  snapshot(): ProgramStats {
    const now = this.o.now();
    return {
      programId: this.programId,
      ...aggregateStats(this.samples.values(), Math.floor(now / 1000)),
      truncated: this.truncated,
      stale: this.stale,
      updatedAt: new Date(this.lastRefresh ?? now).toISOString(),
    };
  }
}
