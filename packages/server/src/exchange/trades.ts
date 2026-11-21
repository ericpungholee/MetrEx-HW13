// Trade and event index (spec-v2 §7.2): getSignaturesForAddress(program) paged newest-first, each
// transaction's events decoded once and deduplicated by (signature, instruction, event). Fills are
// marked finalized or confirming. In memory only: a restart rebuilds the same index from chain.

import type { Connection, PublicKey } from "@solana/web3.js";
import {
  buildChart,
  compareEventPos,
  dedupeEvents,
  type ChartState,
  type OrderFilledEvent,
  type PositionedEvent,
} from "@metrex/exchange";
import { parseTxEvents } from "./events";
import { getExchangeProgram } from "./program";

export interface SigRow {
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  finalized: boolean;
}

export interface TxRow {
  signature: string;
  slot: number;
  blockTime: number | null;
  logs: string[];
}

/** RPC calls the index needs (injectable for tests). */
export interface TradeSource {
  /** Newest-first, like getSignaturesForAddress. */
  signatures(opts: { before?: string; until?: string; limit: number }): Promise<SigRow[]>;
  /** Transactions at confirmed; null if not available yet. */
  transactions(sigs: string[]): Promise<(TxRow | null)[]>;
  /** Which of `sigs` are finalized now. */
  finalized(sigs: string[]): Promise<boolean[]>;
  /** Decodes events of one transaction. */
  decode(tx: TxRow & { txOrder: number }): PositionedEvent[];
}

/**
 * `address` is the program id for a program-wide index, or one market's address for a per-market
 * index: every instruction that emits a market event (split, merge, place, take, match, cancel,
 * sweep, resolve, redeem) passes that market's account, so its signature list is complete for it.
 */
export function connectionTradeSource(getConn: () => Connection, address: PublicKey): TradeSource {
  return {
    async signatures(opts) {
      const rows = await getConn().getSignaturesForAddress(address, opts, "confirmed");
      return rows.map((r) => ({
        signature: r.signature,
        slot: r.slot,
        blockTime: r.blockTime ?? null,
        failed: r.err !== null,
        finalized: r.confirmationStatus === "finalized",
      }));
    },
    async transactions(sigs) {
      const out: (TxRow | null)[] = [];
      for (const signature of sigs) {
        try {
          const t = await getConn().getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          out.push(t?.meta ? { signature, slot: t.slot, blockTime: t.blockTime ?? null, logs: t.meta.logMessages ?? [] } : null);
        } catch {
          out.push(null);
        }
      }
      return out;
    },
    async finalized(sigs) {
      const out: boolean[] = [];
      for (let i = 0; i < sigs.length; i += 256) {
        const st = await getConn().getSignatureStatuses(sigs.slice(i, i + 256));
        for (const s of st.value) out.push(s?.confirmationStatus === "finalized");
      }
      return out;
    },
    decode(tx) {
      return parseTxEvents(getExchangeProgram(getConn()), tx);
    },
  };
}

export interface IndexedTrade {
  signature: string;
  slot: number;
  blockTime: number | null;
  finalized: boolean;
  fill: OrderFilledEvent;
}

interface Entry {
  row: SigRow;
  /** Position in signature paging order (older = smaller), used for same-slot ordering. */
  order: number;
  events: PositionedEvent[] | null;
}

export class TradeIndex {
  private readonly entries = new Map<string, Entry>();
  private newest: string | undefined;
  private nextOrder = 0;
  private inflight: Promise<void> | undefined;
  lastRefresh: number | undefined;
  /** True once every transaction of the initial backfill has been decoded; stays true. */
  backfilled = false;

  constructor(
    private readonly source: TradeSource,
    private readonly opts: { pageSize?: number; maxBackfill?: number; txPerRefresh?: number } = {},
  ) {}

  refresh(): Promise<void> {
    this.inflight ??= this.doRefresh().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  private async doRefresh(): Promise<void> {
    const pageSize = this.opts.pageSize ?? 1_000;
    const maxBackfill = this.opts.maxBackfill ?? 20_000;
    const fresh: SigRow[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.source.signatures({ before, until: this.newest, limit: pageSize });
      fresh.push(...page);
      if (page.length < pageSize || (!this.newest && fresh.length >= maxBackfill)) break;
      before = page[page.length - 1]?.signature;
    }
    // Oldest first so `order` grows with chain order.
    for (const r of fresh.reverse()) {
      const e = this.entries.get(r.signature);
      if (e) {
        e.row.finalized ||= r.finalized;
        continue;
      }
      this.entries.set(r.signature, { row: r, order: this.nextOrder++, events: r.failed ? [] : null });
    }
    if (fresh.length) this.newest = fresh[fresh.length - 1]?.signature;

    // Newest first, so the current round's history appears before older rounds'.
    const missing = [...this.entries.values()]
      .filter((e) => e.events === null)
      .sort((a, b) => b.order - a.order)
      .slice(0, this.opts.txPerRefresh ?? 200);
    const txs = await this.source.transactions(missing.map((e) => e.row.signature));
    missing.forEach((e, i) => {
      const t = txs[i];
      if (t) e.events = this.source.decode({ ...t, txOrder: e.order });
    });
    const pending = [...this.entries.values()].filter((e) => !e.row.finalized && !e.row.failed);
    if (pending.length) {
      const fin = await this.source.finalized(pending.map((e) => e.row.signature));
      pending.forEach((e, i) => (e.row.finalized ||= fin[i] ?? false));
    }
    if (!this.backfilled && ![...this.entries.values()].some((e) => e.events === null)) this.backfilled = true;
    this.lastRefresh = Date.now();
  }

  /** All decoded events in chain order, deduplicated. `finalizedOnly` keeps finalized transactions. */
  events(filter: { market?: string; finalizedOnly?: boolean } = {}): PositionedEvent[] {
    const all: PositionedEvent[] = [];
    for (const e of this.entries.values()) {
      if (!e.events || (filter.finalizedOnly && !e.row.finalized)) continue;
      for (const ev of e.events) if (!filter.market || ("market" in ev && ev.market === filter.market)) all.push(ev);
    }
    return dedupeEvents(all.sort((a, b) => compareEventPos(a.pos, b.pos)));
  }

  /** Fills of a market, newest last, each marked finalized or confirming (§7.2). */
  trades(market: string): IndexedTrade[] {
    return this.events({ market })
      .filter((e): e is OrderFilledEvent & { pos: PositionedEvent["pos"] } => e.name === "OrderFilled")
      .map((e) => ({
        signature: e.pos.signature,
        slot: e.pos.slot,
        blockTime: e.pos.blockTime,
        finalized: this.entries.get(e.pos.signature)?.row.finalized ?? false,
        fill: e,
      }));
  }

  /** §7.3 from finalized events only. */
  chart(market: string): ChartState {
    return buildChart(this.events({ market, finalizedOnly: true }));
  }

  get size(): number {
    return this.entries.size;
  }
}
