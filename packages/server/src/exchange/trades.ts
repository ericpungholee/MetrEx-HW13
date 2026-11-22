// Finalized trade indexing (spec-v2 §7.2). WebSocket notifications supply logs for live
// transactions. Signature pagination orders them, gives them block times and catches any gaps.
import type { PublicKey } from "@solana/web3.js";
import type { OrderFilledEvent, PositionedEvent } from "@metrex/exchange";
import { parseTxEvents } from "./events";
import { getExchangeProgram } from "./program";
import type { RpcPool } from "../rpc";
import type { TradeStore } from "./trade-store";

export interface SigRow {
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
}

export interface PendingReceipt extends SigRow {
  txOrder: number;
  recent: boolean;
}

export interface TxRow {
  signature: string;
  slot: number;
  blockTime: number | null;
  logs: string[];
  txOrder?: number;
}

export interface TradeSource {
  signatures(opts: { before?: string; until?: string; limit: number }): Promise<SigRow[]>;
  transactions(sigs: string[]): Promise<(TxRow | null)[]>;
}

const eventLogs = (logs: readonly string[]) => logs.filter((l) => /^Program (?:data: |\S+ (?:invoke |success$|failed:))/.test(l));

export function connectionTradeSource(rpc: RpcPool, address: PublicKey): TradeSource {
  let canBatch = true;
  return {
    async signatures(opts) {
      const rows = await rpc.run((c) => c.getSignaturesForAddress(address, opts, "finalized"));
      return rows.map((r) => ({ signature: r.signature, slot: r.slot, blockTime: r.blockTime ?? null, failed: r.err !== null }));
    },
    async transactions(sigs) {
      const opts = { commitment: "finalized", maxSupportedTransactionVersion: 0 } as const;
      const load = async () => {
        if (canBatch && sigs.length > 1) {
          try {
            return await rpc.run((c) => c.getTransactions(sigs, opts));
          } catch (e) {
            // Some RPC plans reject JSON-RPC batches. Keep their individual calls paced.
            if (!/batch|invalid request|not supported/i.test(String(e))) throw e;
            canBatch = false;
          }
        }
        return Promise.all(sigs.map((sig) => rpc.run((c) => c.getTransaction(sig, opts)).catch(() => null)));
      };
      const txs = await load();
      const bySignature = new Map(txs.flatMap((tx) => tx ? [[tx.transaction.signatures[0], tx] as const] : []));
      return sigs.map((signature) => {
        const tx = bySignature.get(signature);
        if (!tx?.meta?.logMessages || tx.meta.err || tx.meta.logMessages.includes("Log truncated")) return null;
        return { signature, slot: tx.slot, blockTime: tx.blockTime ?? null, logs: eventLogs(tx.meta.logMessages ?? []) };
      });
    },
  };
}

export function tradeDecoder(rpc: RpcPool): (tx: TxRow) => PositionedEvent[] {
  const program = getExchangeProgram(rpc.connection);
  return (tx) => parseTxEvents(program, tx);
}

export interface IndexedTrade {
  signature: string;
  slot: number;
  blockTime: number | null;
  finalized: boolean;
  fill: OrderFilledEvent & { pos: PositionedEvent["pos"] };
}

export class TradeIndex {
  private readonly notifications = new Map<string, { slot: number; logs: string[] }>();
  private readonly attempts = new Map<string, number>();
  lastRefresh: number | undefined;
  streamed = 0;
  fetched = 0;
  discovered = 0;
  private readonly pageSize = 200;

  constructor(private readonly source: TradeSource, readonly store: TradeStore, private readonly batchSize = 12) {}

  observe(signature: string, slot: number, logs: string[]): void {
    if (this.store.known.has(signature) || logs.includes("Log truncated")) return;
    this.notifications.set(signature, { slot, logs: eventLogs(logs) });
    if (this.notifications.size > 2_000) this.notifications.delete(this.notifications.keys().next().value!);
  }

  async refresh(): Promise<void> {
    await this.discoverRecent();
    const pending = [...this.store.pending.values()];
    const streamed = pending.flatMap((r) => {
      const entry = this.notifications.get(r.signature);
      if (!entry || entry.slot !== r.slot) return [];
      return [{ ...r, logs: entry.logs }];
    });
    this.saveReceipts(streamed);
    this.streamed += streamed.length;
    // Recover recent gaps first. Keep an older slot in every batch that can spare it,
    // so an incomplete old receipt or sustained live flow does not block backfill.
    await this.discoverOlder();
    const available = [...this.store.pending.values()].filter((r) => (this.attempts.get(r.signature) ?? 0) <= Date.now());
    const recent = available.filter((r) => r.recent).reverse();
    const older = available.filter((r) => !r.recent);
    const selected = [...recent.slice(0, this.batchSize), ...older].slice(0, this.batchSize);
    if (older.length && selected.length === this.batchSize && selected.every((r) => r.recent) && this.batchSize > 1) {
      selected[selected.length - 1] = older[0]!;
    }
    if (selected.length) {
      const results = await this.source.transactions(selected.map((r) => r.signature));
      const receipts = selected.flatMap((row, i) => {
        const receipt = results[i];
        if (receipt?.slot === row.slot) return [{ ...receipt, blockTime: row.blockTime ?? receipt.blockTime, txOrder: row.txOrder }];
        this.attempts.set(row.signature, Date.now() + 5_000);
        return [];
      });
      this.saveReceipts(receipts);
      this.fetched += receipts.length;
    }
    this.lastRefresh = Date.now();
  }

  private saveReceipts(receipts: TxRow[]): void {
    if (!receipts.length) return;
    this.store.append({ receipts });
    for (const receipt of receipts) {
      this.notifications.delete(receipt.signature);
      this.attempts.delete(receipt.signature);
    }
  }

  private async discoverRecent(): Promise<void> {
    const head = this.store.head;
    const newest: SigRow[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.source.signatures({ before, until: head?.signature, limit: this.pageSize });
      if (!page.length) break;
      newest.push(...page);
      if (!head || page.length < this.pageSize) break;
      before = page.at(-1)!.signature;
    }
    const fresh = [...new Map(newest.map((r) => [r.signature, r])).values()].filter((r) => r.signature !== head?.signature);
    if (!fresh.length) return;
    let order = head?.order ?? 0;
    const discovered = fresh.reverse().map((r) => ({ ...r, recent: true, txOrder: ++order }));
    this.store.append({
      discovered,
      head: { signature: discovered.at(-1)!.signature, order },
      ...(!head ? { history: { before: discovered[0]!.signature, order: 1 } } : {}),
    });
    this.discovered += discovered.length;
  }

  private async discoverOlder(): Promise<void> {
    const history = this.store.history;
    if (!history?.before || [...this.store.pending.values()].filter((r) => !r.recent).length >= this.pageSize) return;
    const page = await this.source.signatures({ before: history.before, limit: this.pageSize });
    let order = history.order;
    const discovered = page.map((r) => ({ ...r, recent: false, txOrder: --order }));
    this.store.append({ discovered, history: { before: page.length === this.pageSize ? page.at(-1)!.signature : null, order } });
  }
}
