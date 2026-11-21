// Chart reducer (spec-v2 §7.3, flaw #11). Pure: replays OrderPlaced, OrderFilled and
// OrderCancelled events of one market in chain order and produces
//   - "Trades": one point per fill at its execution price, with quantity, and
//   - "Quoted midpoint": best bid, best ask and midpoint after every event that changes them.
// Nothing is interpolated or invented. Expiry is not an event, so an expired order stays in the
// quote history until it is swept or cancelled; the live book (§7.1) hides it immediately.

import { OrderSide, type OutcomeCode } from "./constants";
import type { EventPosition, ExchangeEvent } from "./events";

export interface TradePoint {
  signature: string;
  slot: number;
  blockTime: number | null;
  outcome: OutcomeCode;
  priceBps: number;
  quantity: bigint;
  quoteAmount: bigint;
  buyer: string;
  seller: string;
}

export interface QuotePoint {
  signature: string;
  slot: number;
  blockTime: number | null;
  outcome: OutcomeCode;
  bestBidBps: number | null;
  bestAskBps: number | null;
  /** Midpoint, only when both sides exist. May be a half tick. */
  midBps: number | null;
}

interface LiveOrder {
  outcome: OutcomeCode;
  side: number;
  priceBps: number;
  remaining: bigint;
}

export interface ChartState {
  live: Map<string, LiveOrder>;
  trades: TradePoint[];
  quotes: QuotePoint[];
  last: Map<OutcomeCode, { bid: number | null; ask: number | null }>;
}

export const emptyChart = (): ChartState => ({ live: new Map(), trades: [], quotes: [], last: new Map() });

function best(live: Map<string, LiveOrder>, outcome: OutcomeCode): { bid: number | null; ask: number | null } {
  let bid: number | null = null;
  let ask: number | null = null;
  for (const o of live.values()) {
    if (o.outcome !== outcome || o.remaining === 0n) continue;
    if (o.side === OrderSide.Buy) bid = bid === null ? o.priceBps : Math.max(bid, o.priceBps);
    else ask = ask === null ? o.priceBps : Math.min(ask, o.priceBps);
  }
  return { bid, ask };
}

/** Applies one event. Events must arrive in chain order, deduplicated. Returns the same state object. */
export function reduceChart(s: ChartState, e: ExchangeEvent, pos: EventPosition): ChartState {
  const touched: OutcomeCode[] = [];
  switch (e.name) {
    case "OrderPlaced":
      s.live.set(e.order, { outcome: e.outcome as OutcomeCode, side: e.side, priceBps: e.priceBps, remaining: e.quantity });
      touched.push(e.outcome as OutcomeCode);
      break;
    case "OrderFilled": {
      for (const id of [e.buyOrder, e.sellOrder]) {
        const o = s.live.get(id);
        if (o) o.remaining = o.remaining > e.quantity ? o.remaining - e.quantity : 0n;
      }
      s.trades.push({
        signature: pos.signature,
        slot: pos.slot,
        blockTime: pos.blockTime,
        outcome: e.outcome as OutcomeCode,
        priceBps: e.priceBps,
        quantity: e.quantity,
        quoteAmount: e.quoteAmount,
        buyer: e.buyer,
        seller: e.seller,
      });
      touched.push(e.outcome as OutcomeCode);
      break;
    }
    case "OrderCancelled": {
      const o = s.live.get(e.order);
      if (o) {
        s.live.delete(e.order);
        touched.push(o.outcome);
      }
      break;
    }
    default:
      return s;
  }
  for (const outcome of touched) {
    const b = best(s.live, outcome);
    const prev = s.last.get(outcome);
    if (prev && prev.bid === b.bid && prev.ask === b.ask) continue;
    s.last.set(outcome, b);
    s.quotes.push({
      signature: pos.signature,
      slot: pos.slot,
      blockTime: pos.blockTime,
      outcome,
      bestBidBps: b.bid,
      bestAskBps: b.ask,
      midBps: b.bid !== null && b.ask !== null ? (b.bid + b.ask) / 2 : null,
    });
  }
  return s;
}

/** Full replay from scratch (restart-safe). */
export function buildChart(events: ReadonlyArray<ExchangeEvent & { pos: EventPosition }>): ChartState {
  const s = emptyChart();
  for (const e of events) reduceChart(s, e, e.pos);
  return s;
}

/** Sum of `quote_amount` over fills (volume, §10.2). */
export const volume = (trades: readonly TradePoint[]): bigint => trades.reduce((a, t) => a + t.quoteAmount, 0n);
