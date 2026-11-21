// Engine tests (spec-v2 §13.2): book projection, price-time ordering, levels, headline price,
// event walker and dedup, chart reducer and keeper planning. Pure.
import { describe, expect, it } from "vitest";
import {
  DEMO_BOTS,
  OrderSide,
  Outcome,
  bookFingerprint,
  buildChart,
  dedupeEvents,
  eventKey,
  headlinePrice,
  hiddenReason,
  outcomeBook,
  planKeeperMatches,
  planLimitOrder,
  planMarketOrder,
  projectBook,
  requoteRound,
  volume,
  walkProgramData,
  type BookOrder,
  type ExchangeEvent,
  type EventPosition,
  type MarketContext,
  type OrderAccount,
} from "./index";

const PID = "BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko";
const DEFAULT = "11111111111111111111111111111111";

function acct(p: Partial<OrderAccount> & Pick<OrderAccount, "address" | "seq">): OrderAccount {
  return {
    market: "M",
    maker: "maker",
    clientNonce: 1n,
    outcome: Outcome.Yes,
    side: OrderSide.Buy,
    priceBps: 400,
    originalQty: 100n,
    remainingQty: 100n,
    expiresAt: 0n,
    createdAt: 0n,
    ...p,
  };
}

const ctx = (over: Partial<MarketContext> = {}): MarketContext => ({
  tradingOpen: true,
  unresolved: true,
  now: 1_000n,
  receiveAtaExists: () => true,
  ...over,
});

describe("book projection (§7.1)", () => {
  const orders = [
    acct({ address: "a", seq: 3n, priceBps: 410 }),
    acct({ address: "b", seq: 1n, priceBps: 410, maker: "m2" }),
    acct({ address: "c", seq: 2n, priceBps: 400 }),
    acct({ address: "d", seq: 4n, side: OrderSide.Sell, priceBps: 430, remainingQty: 0n }),
    acct({ address: "e", seq: 5n, side: OrderSide.Sell, priceBps: 450, expiresAt: 1_000n }),
    acct({ address: "f", seq: 6n, side: OrderSide.Sell, priceBps: 460, expiresAt: 1_001n }),
    acct({ address: "g", seq: 7n, side: OrderSide.Sell, priceBps: 470, maker: "noata" }),
    acct({ address: "h", seq: 8n, outcome: Outcome.No, side: OrderSide.Sell, priceBps: 9_600 }),
  ];
  const c = ctx({ receiveAtaExists: (o) => o.maker !== "noata" });

  it("hides filled, expired, missing-ATA orders; closed or resolved markets show nothing", () => {
    expect(hiddenReason(orders[3]!, c)).toBe("filled");
    expect(hiddenReason(orders[4]!, c)).toBe("expired"); // now ≥ expires_at
    expect(hiddenReason(orders[5]!, c)).toBeNull();
    expect(hiddenReason(orders[6]!, c)).toBe("missing_ata");
    expect(projectBook(orders, c).map((o) => o.id)).toEqual(["b", "c", "a", "f", "h"]);
    expect(projectBook(orders, ctx({ tradingOpen: false }))).toEqual([]);
    expect(projectBook(orders, ctx({ unresolved: false }))).toEqual([]);
  });

  it("price-time levels: bids desc, asks asc, ties by seq; YES and NO books separate", () => {
    const yes = outcomeBook(projectBook(orders, c), Outcome.Yes);
    expect(yes.bids.map((l) => [l.priceBps, l.quantity, l.orders.map((o) => o.id)])).toEqual([
      [410, 200n, ["b", "a"]],
      [400, 100n, ["c"]],
    ]);
    expect(yes.asks.map((l) => l.priceBps)).toEqual([460]);
    expect(yes.spreadBps).toBe(50);
    const no = outcomeBook(projectBook(orders, c), Outcome.No);
    expect(no.bids).toEqual([]);
    expect(no.asks.map((l) => l.priceBps)).toEqual([9_600]);
  });

  it("restart rebuild: the same accounts in any order give an identical book", () => {
    const a = projectBook(orders, c);
    const b = projectBook([...orders].reverse(), c);
    expect(bookFingerprint(b)).toBe(bookFingerprint(a));
  });
});

describe("headline price (§10.3)", () => {
  it("mid within 1,000 bps, else last fill, else none", () => {
    expect(headlinePrice({ bestBidBps: 410, bestAskBps: 430 }, 500)).toEqual({ source: "mid", priceBps: 420 });
    expect(headlinePrice({ bestBidBps: 410, bestAskBps: 1_411 }, 500)).toEqual({ source: "last", priceBps: 500 });
    expect(headlinePrice({ bestBidBps: null, bestAskBps: 430 }, null)).toEqual({ source: "none", priceBps: null });
  });
});

describe("planners (§5.5, §5.7)", () => {
  const book: BookOrder[] = [
    { id: "s1", maker: "A", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 430, remaining: 200n, seq: 1n },
    { id: "s2", maker: "B", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 500, remaining: 150n, seq: 2n },
    { id: "s3", maker: "C", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 590, remaining: 100n, seq: 3n },
    { id: "s4", maker: "D", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 600, remaining: 100n, seq: 4n },
    { id: "s5", maker: "E", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 610, remaining: 100n, seq: 5n },
  ];
  it("market order respects slippage and the 4-level limit, skipping own orders", () => {
    const r = planMarketOrder(book, { outcome: Outcome.Yes, side: OrderSide.Buy, qty: 1_000n, worstPriceBps: 9_999, taker: "C" });
    expect(r.fills.map((f) => f.orderId)).toEqual(["s1", "s2", "s4", "s5"]);
    expect(r.unfilled).toBe(450n);
    const capped = planMarketOrder(book, { outcome: Outcome.Yes, side: OrderSide.Buy, qty: 1_000n, worstPriceBps: 500, taker: "X" });
    expect(capped.fills.map((f) => f.orderId)).toEqual(["s1", "s2"]);
  });
  it("limit order fills at the resting price and rests the remainder (3-level limit)", () => {
    const r = planLimitOrder(book, { outcome: Outcome.Yes, side: OrderSide.Buy, qty: 1_000n, priceBps: 9_999, maker: "X" });
    expect(r.fills.length).toBe(3);
    expect(r.rests).toBe(550n);
  });
});

describe("events (§7.2)", () => {
  it("walker attributes Program data lines to top-level instructions and skips CPI programs", () => {
    const logs = [
      `Program ComputeBudget111111111111111111111111111111 invoke [1]`,
      `Program ComputeBudget111111111111111111111111111111 success`,
      `Program ${PID} invoke [1]`,
      `Program log: Instruction: PlaceOrder`,
      `Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]`,
      `Program data: Zm9yZWlnbg==`,
      `Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success`,
      `Program data: AAAA`,
      `Program ${PID} success`,
      `Program ${PID} invoke [1]`,
      `Program data: BBBB`,
      `Program data: CCCC`,
      `Program ${PID} success`,
    ];
    expect(walkProgramData(logs, PID)).toEqual([
      [1, 0, "AAAA"],
      [2, 0, "BBBB"],
      [2, 1, "CCCC"],
    ]);
  });

  it("deduplicates by (signature, ix, event)", () => {
    const pos = (sig: string, ix: number, ev: number): EventPosition => ({ signature: sig, slot: 1, blockTime: null, ixIndex: ix, eventIndex: ev });
    const e = (p: EventPosition) => ({ name: "RoundClosed" as const, data: {}, pos: p });
    const all = [e(pos("x", 0, 0)), e(pos("x", 0, 1)), e(pos("x", 0, 0)), e(pos("y", 0, 0)), e(pos("x", 1, 0))];
    expect(dedupeEvents(all).map((x) => eventKey(x.pos))).toEqual(["x:0:0", "x:0:1", "y:0:0", "x:1:0"]);
  });
});

describe("chart reducer (§7.3)", () => {
  let n = 0;
  const at = (slot: number): EventPosition => ({ signature: `s${n++}`, slot, blockTime: 1_700_000_000 + slot, ixIndex: 0, eventIndex: 0 });
  const placed = (order: string, side: number, price: number, qty: bigint): ExchangeEvent => ({
    name: "OrderPlaced", market: "M", order, maker: order, outcome: Outcome.Yes, side, priceBps: price, quantity: qty, seq: 0n, expiresAt: 0n,
  });

  it("empty history has no points (never invented)", () => {
    const c = buildChart([]);
    expect(c.trades).toEqual([]);
    expect(c.quotes).toEqual([]);
  });

  it("quote history follows real commitments; fills are points at execution prices", () => {
    const events = [
      { ...placed("bidC", OrderSide.Buy, 410, 100n), pos: at(1) },
      { ...placed("askA", OrderSide.Sell, 430, 200n), pos: at(2) },
      { ...placed("bidB", OrderSide.Buy, 400, 150n), pos: at(3) }, // best unchanged: no new point
      {
        name: "OrderFilled" as const, market: "M", outcome: Outcome.Yes, buyOrder: DEFAULT, sellOrder: "askA", buyer: "P", seller: "askA",
        quantity: 200n, priceBps: 430, quoteAmount: 8_600_000n, buyerRefund: 0n, makerOrder: "askA", pos: at(4),
      },
      { name: "OrderCancelled" as const, market: "M", order: "bidC", maker: "bidC", swept: false, remainingQty: 100n, returnedAmount: 0n, pos: at(5) },
    ];
    const c = buildChart(events);
    expect(c.quotes.map((q) => [q.bestBidBps, q.bestAskBps, q.midBps])).toEqual([
      [410, null, null],
      [410, 430, 420],
      [410, null, null], // ask fully filled
      [400, null, null], // C cancelled
    ]);
    expect(c.trades.map((t) => [t.priceBps, t.quantity])).toEqual([[430, 200n]]);
    expect(volume(c.trades)).toBe(8_600_000n);
  });
});

describe("keeper (§7.4)", () => {
  const o = (id: string, maker: string, side: number, price: number, rem: bigint, seq: bigint): BookOrder => ({
    id, maker, outcome: Outcome.Yes, side: side as 0 | 1, priceBps: price, remaining: rem, seq,
  });

  it("a crossed pair is matched once, at the older price, for min(remaining)", () => {
    const book = [o("bid", "U1", OrderSide.Buy, 450, 50n, 2n), o("ask", "U2", OrderSide.Sell, 420, 80n, 1n)];
    const plan = planKeeperMatches(book);
    expect(plan.map((p) => [p.buy.id, p.sell.id, p.quantity, p.priceBps])).toEqual([["bid", "ask", 50n, 420]]);
    expect(planKeeperMatches(book, new Set(["ask"]))).toEqual([]); // in flight: not matched again
  });

  it("never pairs one order twice in a tick and skips same-maker pairs", () => {
    const book = [
      o("b1", "U1", OrderSide.Buy, 500, 10n, 1n),
      o("b2", "U3", OrderSide.Buy, 490, 10n, 2n),
      o("a1", "U1", OrderSide.Sell, 480, 10n, 3n),
      o("a2", "U2", OrderSide.Sell, 485, 10n, 4n),
    ];
    const plan = planKeeperMatches(book);
    expect(plan.map((p) => [p.buy.id, p.sell.id])).toEqual([["b1", "a2"], ["b2", "a1"]]);
  });

  it("bots-keeper-idle on the projected bot book", () => {
    const b = requoteRound(DEMO_BOTS, requoteRound(DEMO_BOTS, [], new Map(), { skewEnabled: false }), new Map(), { skewEnabled: false });
    expect(planKeeperMatches(b)).toEqual([]);
  });
});
