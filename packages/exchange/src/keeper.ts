// Keeper planning (spec-v2 §7.4). Pure. Policy only: the program enforces prices and quantities.

import { Outcome, type OutcomeCode } from "./constants";
import { crossedPairs, type BookOrder } from "./book";

export interface PlannedMatch {
  outcome: OutcomeCode;
  buy: BookOrder;
  sell: BookOrder;
  /** `min(remainings)`. */
  quantity: bigint;
  /** Execution price the program will use: the older order's price (§5.3). */
  priceBps: number;
}

/**
 * For each outcome, the oldest eligible crossed pairs in price-time order. Each order appears in at
 * most one planned match, and orders in `inFlight` are skipped (one in-flight match per order), so
 * a crossed pair is never matched twice by one keeper.
 */
export function planKeeperMatches(book: readonly BookOrder[], inFlight: ReadonlySet<string> = new Set()): PlannedMatch[] {
  const out: PlannedMatch[] = [];
  for (const outcome of [Outcome.Yes, Outcome.No] as const) {
    const used = new Set(inFlight);
    for (const [bid, ask] of crossedPairs(book, outcome)) {
      if (used.has(bid.id) || used.has(ask.id)) continue;
      used.add(bid.id);
      used.add(ask.id);
      const older = bid.seq < ask.seq ? bid : ask;
      out.push({
        outcome,
        buy: bid,
        sell: ask,
        quantity: bid.remaining < ask.remaining ? bid.remaining : ask.remaining,
        priceBps: older.priceBps,
      });
    }
  }
  return out;
}
