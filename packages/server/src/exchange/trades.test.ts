// Finalized trade index and keeper regressions (spec-v2 §7.2 and §5.8).
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Outcome, OrderSide, type OrderAccount, type PositionedEvent } from "@metrex/exchange";
import { TradeIndex, type SigRow, type TxRow } from "./trades";
import { TradeStore } from "./trade-store";
import { sweepable } from "./keeper";
import type { RoundView } from "./accounts";

const paths: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of paths.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeChain() {
  const dir = mkdtempSync(join(tmpdir(), "metrex-trade-test-"));
  paths.push(dir);
  const path = join(dir, "journal.jsonl");
  const rows: SigRow[] = [];
  const missing = new Set<string>();
  const signatures = vi.fn(async ({ before, until, limit }: { before?: string; until?: string; limit: number }) => {
    const list = [...rows].reverse();
    const start = before ? list.findIndex((r) => r.signature === before) + 1 : 0;
    const end = until ? list.findIndex((r) => r.signature === until) : list.length;
    return list.slice(start, Math.min(start + limit, end < 0 ? list.length : end));
  });
  const transactions = vi.fn(async (sigs: string[]) => sigs.map((signature) => {
    const row = rows.find((r) => r.signature === signature);
    return !row || missing.has(signature) ? null : { signature, slot: row.slot, blockTime: row.blockTime, logs: [] };
  }));
  const decode = (tx: TxRow): PositionedEvent[] => [{
    name: "OrderFilled", market: "M", outcome: Outcome.Yes, buyOrder: "bid", sellOrder: "ask",
    buyer: "P", seller: "A", quantity: 200n, priceBps: 430, quoteAmount: 8_600_000n, buyerRefund: 0n, makerOrder: "ask",
    pos: { signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, ixIndex: 0, eventIndex: 0, txOrder: tx.txOrder },
  }];
  const push = (signature: string, slot: number, failed = false) => rows.push({ signature, slot, failed, blockTime: 1_700_000_000 + slot });
  const open = (writer = false) => new TradeStore(path, decode, writer);
  return { source: { signatures, transactions }, missing, push, path, open };
}

describe("finalized trade journal", () => {
  it("publishes live fills during backfill and fetches only gaps over HTTP", async () => {
    const c = fakeChain();
    for (let i = 0; i < 205; i++) c.push(`older${i}`, 10 + i);
    const write = c.open(true);
    const read = c.open();
    const index = new TradeIndex(c.source, write, 2);
    await index.refresh();
    expect(read.trades("M")).toEqual([]);
    read.reload();
    expect(read.backfilled).toBe(false);
    expect(read.trades("M").length).toBe(2);
    c.push("live", 220);
    c.push("failed", 221, true);
    index.observe("live", 220, []);
    await index.refresh();
    read.reload();
    expect(read.trades("M").at(-1)?.signature).toBe("live");
    expect(read.chart("M").trades.at(-1)?.quantity).toBe(200n);
    expect(c.source.transactions.mock.calls.flat(2)).not.toContain("live");
    expect(c.source.transactions.mock.calls.flat(2)).not.toContain("failed");
  });

  it("continues indexing around an unavailable receipt and persists pending work", async () => {
    const c = fakeChain();
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    c.push("older", 10);
    c.push("missing", 11);
    c.missing.add("missing");
    let index = new TradeIndex(c.source, c.open(true), 1);
    await index.refresh();
    await index.refresh();
    expect(c.open().trades("M").map((t) => t.signature)).toEqual(["older"]);
    expect(index.store.backfilled).toBe(false);
    c.missing.clear();
    now += 6_000;
    index = new TradeIndex(c.source, c.open(true), 1);
    await index.refresh();
    expect(index.store.backfilled).toBe(true);
    expect(c.open().trades("M").map((t) => t.signature)).toEqual(["older", "missing"]);
  });

  it("reopens a journal without refetching transactions and recovers a partial tail", async () => {
    const c = fakeChain();
    for (let i = 0; i < 7; i++) c.push(`s${i}`, 20 + Math.floor(i / 2));
    const a = new TradeIndex(c.source, c.open(true));
    await a.refresh();
    appendFileSync(c.path, '{"receipts":');
    const read = c.open();
    expect(read.events("M")).toEqual(a.store.events("M"));
    c.source.transactions.mockClear();
    c.push("new", 23);
    const b = new TradeIndex(c.source, c.open(true));
    await b.refresh();
    read.reload();
    expect(c.source.transactions).toHaveBeenCalledExactlyOnceWith(["new"]);
    expect(read.events("M").map((e) => e.pos.signature)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5", "s6", "new"]);
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
