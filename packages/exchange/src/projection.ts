// Book projection from on-chain Order accounts (spec-v2 §7.1). Pure: the caller fetches the
// accounts and the maker ATA existence; this module decides what is shown and in what order.

import { BPS_DENOMINATOR, OrderSide, Outcome, type OrderSideCode, type OutcomeCode } from "./constants";
import { sorted, type BookOrder } from "./book";

/** An Order account as read from chain (keys base58, amounts bigint). */
export interface OrderAccount {
  /** Order PDA. */
  address: string;
  market: string;
  maker: string;
  clientNonce: bigint;
  outcome: OutcomeCode;
  side: OrderSideCode;
  priceBps: number;
  originalQty: bigint;
  remainingQty: bigint;
  seq: bigint;
  /** Unix seconds; 0 = never. */
  expiresAt: bigint;
  createdAt: bigint;
}

export interface MarketContext {
  /** Round is Open and `now < trading_ends_at`. */
  tradingOpen: boolean;
  /** Market outcome is Unresolved. */
  unresolved: boolean;
  /** Chain time, unix seconds. */
  now: bigint;
  /**
   * The maker's receiving ATA exists (outcome mint for BUY, mUSD for SELL). Orders whose
   * receiving ATA is missing would fail to fill, so they are hidden (flaw #15).
   */
  receiveAtaExists: (o: OrderAccount) => boolean;
}

export type HiddenReason = "filled" | "expired" | "missing_ata" | "market_closed";

/** Why an order is not on the book, or null if it is active (§5.2). */
export function hiddenReason(o: OrderAccount, ctx: MarketContext): HiddenReason | null {
  if (!ctx.tradingOpen || !ctx.unresolved) return "market_closed";
  if (o.remainingQty === 0n) return "filled";
  if (o.expiresAt !== 0n && ctx.now >= o.expiresAt) return "expired";
  if (!ctx.receiveAtaExists(o)) return "missing_ata";
  return null;
}

export const toBookOrder = (o: OrderAccount): BookOrder => ({
  id: o.address,
  maker: o.maker,
  outcome: o.outcome,
  side: o.side,
  priceBps: o.priceBps,
  remaining: o.remainingQty,
  seq: o.seq,
});

/** Active orders of one market as book rows. Deterministic: sorted by seq. */
export function projectBook(orders: readonly OrderAccount[], ctx: MarketContext): BookOrder[] {
  return orders
    .filter((o) => hiddenReason(o, ctx) === null)
    .map(toBookOrder)
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

export interface Level {
  priceBps: number;
  quantity: bigint;
  /** Orders at this level in time priority (oldest first), for building fills. */
  orders: BookOrder[];
}

export interface OutcomeBook {
  outcome: OutcomeCode;
  /** Price descending. */
  bids: Level[];
  /** Price ascending. */
  asks: Level[];
  bestBidBps: number | null;
  bestAskBps: number | null;
  /** bestAsk − bestBid, or null if one side is empty. */
  spreadBps: number | null;
  bidDepth: bigint;
  askDepth: bigint;
}

function levels(rows: BookOrder[]): Level[] {
  const out: Level[] = [];
  for (const o of rows) {
    const last = out[out.length - 1];
    if (last && last.priceBps === o.priceBps) {
      last.quantity += o.remaining;
      last.orders.push(o);
    } else {
      out.push({ priceBps: o.priceBps, quantity: o.remaining, orders: [o] });
    }
  }
  return out;
}

/** Aggregated levels for one outcome (§7.1: separate YES and NO books). */
export function outcomeBook(book: readonly BookOrder[], outcome: OutcomeCode): OutcomeBook {
  const bids = levels(sorted(book, outcome, OrderSide.Buy));
  const asks = levels(sorted(book, outcome, OrderSide.Sell));
  const bestBidBps = bids[0]?.priceBps ?? null;
  const bestAskBps = asks[0]?.priceBps ?? null;
  const sum = (ls: Level[]) => ls.reduce((a, l) => a + l.quantity, 0n);
  return {
    outcome,
    bids,
    asks,
    bestBidBps,
    bestAskBps,
    spreadBps: bestBidBps !== null && bestAskBps !== null ? bestAskBps - bestBidBps : null,
    bidDepth: sum(bids),
    askDepth: sum(asks),
  };
}

/** Headline rule (§10.3): mid when both sides exist and spread ≤ 1,000 bps, else last fill, else none. */
export const HEADLINE_MAX_SPREAD_BPS = 1_000;

export type Headline =
  | { source: "mid"; priceBps: number }
  | { source: "last"; priceBps: number }
  | { source: "none"; priceBps: null };

export function headlinePrice(b: Pick<OutcomeBook, "bestBidBps" | "bestAskBps">, lastFillBps: number | null): Headline {
  if (b.bestBidBps !== null && b.bestAskBps !== null && b.bestAskBps - b.bestBidBps <= HEADLINE_MAX_SPREAD_BPS) {
    // Midpoint in bps; a half-tick midpoint is shown at one decimal, so keep it exact ×2 → /2 as a float label only.
    return { source: "mid", priceBps: (b.bestBidBps + b.bestAskBps) / 2 };
  }
  if (lastFillBps !== null) return { source: "last", priceBps: lastFillBps };
  return { source: "none", priceBps: null };
}

/** Complement shown next to a book. Display only, always labelled "indicative" (§3). */
export const indicativeComplement = (priceBps: number): number => BPS_DENOMINATOR - priceBps;

/** Identity of a projected book, for the restart-rebuild test (§13.2 Indexer). */
export function bookFingerprint(book: readonly BookOrder[]): string {
  return [...book]
    .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : a.id < b.id ? -1 : 1))
    .map((o) => `${o.id}:${o.maker}:${o.outcome}:${o.side}:${o.priceBps}:${o.remaining}:${o.seq}`)
    .join("|");
}

/** Convenience: the YES and NO books of one market. */
export const marketBooks = (book: readonly BookOrder[]) => ({
  yes: outcomeBook(book, Outcome.Yes),
  no: outcomeBook(book, Outcome.No),
});
