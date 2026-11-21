// Pure order-book model (spec-v2 §5.3–§5.7, §7.1). Policy code, not frozen: the program enforces
// prices and quantities; this module decides which eligible orders a client or keeper picks.

import { MAX_MATCH_LEVELS, MAX_TAKE_LEVELS, OrderSide, type OrderSideCode, type OutcomeCode } from "./constants";
import { quote } from "./math";

export interface BookOrder {
  id: string;
  maker: string;
  outcome: OutcomeCode;
  side: OrderSideCode;
  priceBps: number;
  remaining: bigint;
  /** Lower is older (§5.3). */
  seq: bigint;
}

export interface Fill {
  orderId: string;
  maker: string;
  seq: bigint;
  qty: bigint;
  /** Execution price: always the resting (older) order's price. */
  priceBps: number;
  quote: bigint;
}

/** Bids: price desc, then seq asc. Asks: price asc, then seq asc. */
export function sorted(book: readonly BookOrder[], outcome: OutcomeCode, side: OrderSideCode): BookOrder[] {
  return book
    .filter((o) => o.outcome === outcome && o.side === side && o.remaining > 0n)
    .sort((a, b) => {
      const p = side === OrderSide.Buy ? b.priceBps - a.priceBps : a.priceBps - b.priceBps;
      if (p !== 0) return p;
      return a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0;
    });
}

export function bestBid(book: readonly BookOrder[], outcome: OutcomeCode): BookOrder | undefined {
  return sorted(book, outcome, OrderSide.Buy)[0];
}
export function bestAsk(book: readonly BookOrder[], outcome: OutcomeCode): BookOrder | undefined {
  return sorted(book, outcome, OrderSide.Sell)[0];
}

/** Matchable resting pairs (bid ≥ ask, different makers), price-time order — the keeper's work list. */
export function crossedPairs(book: readonly BookOrder[], outcome: OutcomeCode): Array<[BookOrder, BookOrder]> {
  const out: Array<[BookOrder, BookOrder]> = [];
  for (const bid of sorted(book, outcome, OrderSide.Buy)) {
    for (const ask of sorted(book, outcome, OrderSide.Sell)) {
      if (bid.priceBps < ask.priceBps) break;
      if (bid.maker !== ask.maker) out.push([bid, ask]);
    }
  }
  return out;
}

function sweep(
  book: readonly BookOrder[],
  outcome: OutcomeCode,
  takerSide: OrderSideCode,
  qty: bigint,
  limitPriceBps: number,
  taker: string,
  maxLevels: number,
): { fills: Fill[]; unfilled: bigint } {
  const restingSide = takerSide === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy;
  const fills: Fill[] = [];
  let left = qty;
  for (const o of sorted(book, outcome, restingSide)) {
    if (left === 0n || fills.length >= maxLevels) break;
    const ok = takerSide === OrderSide.Buy ? o.priceBps <= limitPriceBps : o.priceBps >= limitPriceBps;
    if (!ok) break;
    if (o.maker === taker) continue; // self-trade is rejected on-chain (I12)
    const f = o.remaining < left ? o.remaining : left;
    fills.push({ orderId: o.id, maker: o.maker, seq: o.seq, qty: f, priceBps: o.priceBps, quote: quote(f, o.priceBps) });
    left -= f;
  }
  return { fills, unfilled: left };
}

/** Market order (§5.7): up to `MAX_TAKE_LEVELS` `take_order`s, each limited to `worstPriceBps`. */
export function planMarketOrder(
  book: readonly BookOrder[],
  p: { outcome: OutcomeCode; side: OrderSideCode; qty: bigint; worstPriceBps: number; taker: string },
): { fills: Fill[]; unfilled: bigint; totalQuote: bigint } {
  const r = sweep(book, p.outcome, p.side, p.qty, p.worstPriceBps, p.taker, MAX_TAKE_LEVELS);
  return { ...r, totalQuote: r.fills.reduce((a, f) => a + f.quote, 0n) };
}

/** Limit order (§5.5): `place_order` then `match_orders` against up to `MAX_MATCH_LEVELS` crossing orders. */
export function planLimitOrder(
  book: readonly BookOrder[],
  p: { outcome: OutcomeCode; side: OrderSideCode; qty: bigint; priceBps: number; maker: string },
): { fills: Fill[]; rests: bigint; totalQuote: bigint } {
  const r = sweep(book, p.outcome, p.side, p.qty, p.priceBps, p.maker, MAX_MATCH_LEVELS);
  return { fills: r.fills, rests: r.unfilled, totalQuote: r.fills.reduce((a, f) => a + f.quote, 0n) };
}

/** Apply fills to a book (returns a new book; fully filled orders removed). */
export function applyFills(book: readonly BookOrder[], fills: readonly Fill[]): BookOrder[] {
  const byId = new Map(fills.map((f) => [f.orderId, f.qty]));
  return book
    .map((o) => (byId.has(o.id) ? { ...o, remaining: o.remaining - (byId.get(o.id) ?? 0n) } : o))
    .filter((o) => o.remaining > 0n);
}
