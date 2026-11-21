// Indexer (spec-v2 §13.2): event deduplication, restart rebuild, finalized vs confirming fills,
// and the keeper's sweep rule.
import { describe, expect, it } from "vitest";
import { Outcome, OrderSide, type OrderAccount, type PositionedEvent } from "@metrex/exchange";
import { TradeIndex, type SigRow, type TradeSource, type TxRow } from "./trades";
import { sweepable } from "./keeper";
import type { RoundView } from "./accounts";

const DEFAULT = "11111111111111111111111111111111";

/** A chain of transactions, newest last; each carries ready-decoded events. */
function fakeChain() {
  const txs: Array<{ row: SigRow; tx: TxRow; events: Omit<PositionedEvent, "pos">[] }> = [];
  let duplicatePages = false;
  const source: TradeSource = {
    async signatures({ before, until, limit }) {
      const newestFirst = [...txs].reverse().map((t) => t.row);
      let start = before ? newestFirst.findIndex((r) => r.signature === before) + 1 : 0;
      let end = until ? newestFirst.findIndex((r) => r.signature === until) : newestFirst.length;
      if (end < 0) end = newestFirst.length;
      if (duplicatePages && until) end = Math.min(newestFirst.length, end + 1); // overlap: re-send the known newest
      if (start < 0) start = 0;
      return newestFirst.slice(start, Math.min(end, start + limit));
    },
    async transactions(sigs) {
      return sigs.map((s) => txs.find((t) => t.row.signature === s)?.tx ?? null);
    },
    async finalized(sigs) {
      return sigs.map((s) => txs.find((t) => t.row.signature === s)?.row.finalized ?? false);
    },
    decode(tx) {
      const t = txs.find((x) => x.row.signature === tx.signature);
      return (t?.events ?? []).map((e, i) => ({ ...e, pos: { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, ixIndex: 0, eventIndex: i, txOrder: tx.txOrder } }) as PositionedEvent);
    },
  };
  const fill = (qty: bigint, price: number) => ({
    name: "OrderFilled" as const, market: "M", outcome: Outcome.Yes, buyOrder: DEFAULT, sellOrder: "ask", buyer: "P", seller: "A",
    quantity: qty, priceBps: price, quoteAmount: qty * BigInt(price) * 100n, buyerRefund: 0n, makerOrder: "ask",
  });
  const push = (sig: string, slot: number, events: Omit<PositionedEvent, "pos">[], finalized = true, failed = false) =>
    txs.push({ row: { signature: sig, slot, blockTime: 1_700_000_000 + slot, failed, finalized }, tx: { signature: sig, slot, blockTime: 1_700_000_000 + slot, logs: [] }, events });
  return { source, push, fill, txs, overlap: () => (duplicatePages = true) };
}

describe("trade index (§7.2)", () => {
  it("deduplicates across overlapping refreshes and pages, skips failed transactions", async () => {
    const c = fakeChain();
    c.push("t1", 10, [c.fill(200n, 430), c.fill(100n, 500)]);
    c.push("t2", 11, [c.fill(5n, 430)], true, true); // failed: no events counted
    const idx = new TradeIndex(c.source, { pageSize: 1 });
    await idx.refresh();
    c.overlap();
    c.push("t3", 12, [c.fill(100n, 410)], false);
    await idx.refresh();
    await idx.refresh();
    expect(idx.trades("M").map((t) => [t.signature, t.fill.quantity, t.finalized])).toEqual([
      ["t1", 200n, true],
      ["t1", 100n, true],
      ["t3", 100n, false], // confirming
    ]);
    expect(idx.chart("M").trades.map((t) => t.quantity)).toEqual([200n, 100n]); // chart uses finalized only
    c.txs[2]!.row.finalized = true;
    await idx.refresh();
    expect(idx.trades("M").every((t) => t.finalized)).toBe(true);
  });

  it("decodes later receipts while an unavailable receipt is retried, and backfills it on recovery", async () => {
    const chain = fakeChain();
    chain.push("older", 10, [chain.fill(1n, 10)]);
    chain.push("missing", 11, [chain.fill(2n, 12)]);
    let available = false;
    const idx = new TradeIndex({
      ...chain.source,
      async transactions(sigs) {
        const result = await chain.source.transactions(sigs);
        return result.map((row) => row?.signature === "missing" && !available ? null : row);
      },
    }, { txPerRefresh: 1 });
    await idx.refresh();
    expect(idx.backfilled).toBe(false);
    await idx.refresh();
    expect(idx.trades("M").map((t) => t.signature)).toEqual(["older"]);
    available = true;
    await idx.refresh();
    expect(idx.backfilled).toBe(true);
    expect(idx.trades("M").map((t) => t.signature)).toEqual(["older", "missing"]);
  });

  it("a restart rebuilds an identical index", async () => {
    const c = fakeChain();
    for (let i = 0; i < 7; i++) c.push(`s${i}`, 20 + Math.floor(i / 2), [c.fill(BigInt(i + 1), 400 + i)]);
    const a = new TradeIndex(c.source, { pageSize: 3 });
    await a.refresh();
    const b = new TradeIndex(c.source, { pageSize: 2 });
    await b.refresh();
    const ser = (x: TradeIndex) => JSON.stringify(x.events(), (_, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(ser(b)).toBe(ser(a));
    expect(a.events().map((e) => e.pos.signature)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6"]);
  });
});

describe("keeper sweep rule (§5.8)", () => {
  const round = (o: Partial<RoundView>) => ({ status: "open", tradingEndsAt: 1_000n, ...o }) as RoundView;
  const ord = (o: Partial<OrderAccount>) => ({ remainingQty: 10n, expiresAt: 0n, side: OrderSide.Buy, ...o }) as OrderAccount;
  it("sweeps after close, after the deadline, when expired or filled; never a live order", () => {
    expect(sweepable(ord({}), { round: round({}), now: 999n })).toBe(false);
    expect(sweepable(ord({}), { round: round({ status: "closed" }), now: 10n })).toBe(true);
    expect(sweepable(ord({}), { round: round({}), now: 1_000n })).toBe(true);
    expect(sweepable(ord({ expiresAt: 500n }), { round: round({}), now: 500n })).toBe(true);
    expect(sweepable(ord({ remainingQty: 0n }), { round: round({}), now: 10n })).toBe(true);
  });
});
