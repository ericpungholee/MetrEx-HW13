// What a simulated trader can see of one market (docs/spec-simulation.md §5): the live book from
// chain accounts and a short in-memory history of its YES mid. Pure.

import { BPS_DENOMINATOR, Outcome, bestAsk, bestBid, bpsToLogit, type BookOrder, type Hazard } from "@metrex/exchange";

export interface Quotes {
  yesBid?: BookOrder;
  yesAsk?: BookOrder;
  noBid?: BookOrder;
  noAsk?: BookOrder;
}

export function quotesOf(book: readonly BookOrder[]): Quotes {
  return { yesBid: bestBid(book, Outcome.Yes), yesAsk: bestAsk(book, Outcome.Yes), noBid: bestBid(book, Outcome.No), noAsk: bestAsk(book, Outcome.No) };
}

/**
 * YES mid from both books: best YES-equivalent bid (YES bid, or 10,000 − NO ask) and ask (YES ask,
 * or 10,000 − NO bid). Undefined when either side is empty.
 */
export function yesMidBps(q: Quotes): number | undefined {
  const bids = [q.yesBid?.priceBps, q.noAsk ? BPS_DENOMINATOR - q.noAsk.priceBps : undefined].filter((x): x is number => x !== undefined);
  const asks = [q.yesAsk?.priceBps, q.noBid ? BPS_DENOMINATOR - q.noBid.priceBps : undefined].filter((x): x is number => x !== undefined);
  if (!bids.length || !asks.length) return undefined;
  const bid = Math.max(...bids);
  const ask = Math.min(...asks);
  return bid < ask ? (bid + ask) / 2 : (Math.min(...bids) + Math.max(...asks)) / 2;
}

/** Ring of (time, logit YES mid) samples for momentum. */
export class MidHistory {
  private readonly pts: Array<{ t: number; x: number }> = [];
  constructor(private readonly keepMs = 30 * 60_000) {}

  push(t: number, midBps: number): void {
    this.pts.push({ t, x: bpsToLogit(midBps) });
    while (this.pts.length && (this.pts[0]?.t ?? t) < t - this.keepMs) this.pts.shift();
  }

  /** Change in logit mid over the last `windowMin` minutes; undefined until that much history exists. */
  change(nowMs: number, windowMin: number): number | undefined {
    const last = this.pts[this.pts.length - 1];
    const first = this.pts[0];
    if (!last || !first || first.t > nowMs - windowMin * 60_000) return undefined;
    let ref = first;
    for (const p of this.pts) {
      if (p.t > nowMs - windowMin * 60_000) break;
      ref = p;
    }
    return last.x - ref.x;
  }

  get size(): number {
    return this.pts.length;
  }
}

export interface MarketCtx {
  hazard: Hazard;
  /** Market account, base58. */
  market: string;
  /** Public starting quote (catalog maker A reference), bps. */
  anchorBps: number;
  book: readonly BookOrder[];
  quotes: Quotes;
  midBps: number | undefined;
  /** Bulletin signal for the hazard now, log-odds. */
  signal: number;
  momentum: (windowMin: number) => number | undefined;
  /** Chain time, unix seconds. */
  chainNow: bigint;
}
