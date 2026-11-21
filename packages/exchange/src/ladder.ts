// Market-maker quote ladder (spec-v2 §8.2). Policy code, not frozen. Pure: no I/O.
//
// Rules: fixed illustrative beliefs; inventory skew (off on the featured market); NO quoted as the
// exact complement of YES; post-only against sibling bots on BOTH books (within-book crosses and
// cross-book arbitrage); post-only against user orders that are ≥ `respectMinQty` and within
// `respectBandBps` of the bot's reference (so a dust order at an absurd price cannot erase bot depth).

import { BPS_DENOMINATOR, MAX_PRICE_BPS, MIN_PRICE_BPS, Outcome, OrderSide, type OutcomeCode } from "./constants";
import type { BookOrder } from "./book";

export interface BotParams {
  name: string;
  refBps: number;
  halfSpreadBps: number;
  topSize: bigint;
  /** Shares of net YES exposure at which skew reaches `skewMaxBps`. */
  toleranceShares: bigint;
  skewMaxBps: number;
}

/** Shipped ladder (§8.2). Highest bid 410 < lowest ask 430 at zero inventory. */
export const DEMO_BOTS: readonly BotParams[] = [
  { name: "A", refBps: 400, halfSpreadBps: 30, topSize: 200n, toleranceShares: 2_000n, skewMaxBps: 20 },
  { name: "B", refBps: 450, halfSpreadBps: 50, topSize: 150n, toleranceShares: 4_000n, skewMaxBps: 30 },
  { name: "C", refBps: 500, halfSpreadBps: 90, topSize: 100n, toleranceShares: 8_000n, skewMaxBps: 40 },
];

export const RESPECT_MIN_QTY = 10n;
export const RESPECT_BAND_BPS = 300;

export interface Quote {
  bot: string;
  outcome: OutcomeCode;
  side: 0 | 1;
  priceBps: number;
  size: bigint;
}

export interface QuoteOptions {
  /** Featured market: skew off (§8.3). */
  skewEnabled: boolean;
  respectMinQty?: bigint;
  respectBandBps?: number;
}

/** Skewed reference. A bot short YES (`netYes < 0`) raises its quotes to buy YES back. */
export function skewedRef(p: BotParams, netYes: bigint, skewEnabled: boolean): number {
  if (!skewEnabled || p.skewMaxBps === 0) return p.refBps;
  const raw = (-Number(netYes) / Number(p.toleranceShares)) * p.skewMaxBps;
  const s = Math.max(-p.skewMaxBps, Math.min(p.skewMaxBps, Math.round(raw)));
  return p.refBps + s;
}

/** Unclamped targets: YES bid/ask around the reference, NO as exact complements. */
export function targetQuotes(p: BotParams, netYes: bigint, skewEnabled: boolean): Quote[] {
  const ref = skewedRef(p, netYes, skewEnabled);
  const yesBid = ref - p.halfSpreadBps;
  const yesAsk = ref + p.halfSpreadBps;
  return [
    { bot: p.name, outcome: Outcome.Yes, side: OrderSide.Buy, priceBps: yesBid, size: p.topSize },
    { bot: p.name, outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: yesAsk, size: p.topSize },
    { bot: p.name, outcome: Outcome.No, side: OrderSide.Buy, priceBps: BPS_DENOMINATOR - yesAsk, size: p.topSize },
    { bot: p.name, outcome: Outcome.No, side: OrderSide.Sell, priceBps: BPS_DENOMINATOR - yesBid, size: p.topSize },
  ];
}

const other = (o: OutcomeCode): OutcomeCode => (o === Outcome.Yes ? Outcome.No : Outcome.Yes);

/**
 * Clamp one bot's targets against the live book (`others` excludes this bot's own orders).
 * Returns the quotes to post; a level that cannot be placed without crossing is dropped.
 */
export function clampQuotes(
  p: BotParams,
  targets: readonly Quote[],
  others: readonly (BookOrder & { isBot: boolean })[],
  opts: QuoteOptions,
): Quote[] {
  const minQty = opts.respectMinQty ?? RESPECT_MIN_QTY;
  const band = opts.respectBandBps ?? RESPECT_BAND_BPS;
  const respected = (o: BookOrder & { isBot: boolean }): boolean => {
    if (o.isBot) return true;
    if (o.remaining < minQty) return false;
    const yesEquiv = o.outcome === Outcome.Yes ? o.priceBps : BPS_DENOMINATOR - o.priceBps;
    return Math.abs(yesEquiv - p.refBps) <= band;
  };
  const live = others.filter((o) => o.remaining > 0n && respected(o));
  const prices = (outcome: OutcomeCode, side: 0 | 1, botsOnly: boolean) =>
    live.filter((o) => o.outcome === outcome && o.side === side && (!botsOnly || o.isBot)).map((o) => o.priceBps);

  const out: Quote[] = [];
  for (const q of targets) {
    let price = q.priceBps;
    if (q.side === OrderSide.Buy) {
      // Within-book: strictly below every respected ask.
      for (const a of prices(q.outcome, OrderSide.Sell, false)) price = Math.min(price, a - 1);
      // Cross-book vs sibling bots: my bid + their opposite-outcome bid ≤ 10,000 (no split-and-sell profit).
      for (const b of prices(other(q.outcome), OrderSide.Buy, true)) price = Math.min(price, BPS_DENOMINATOR - b);
    } else {
      for (const b of prices(q.outcome, OrderSide.Buy, false)) price = Math.max(price, b + 1);
      // Cross-book vs sibling bots: my ask + their opposite-outcome ask ≥ 10,000 (no buy-and-merge profit).
      for (const a of prices(other(q.outcome), OrderSide.Sell, true)) price = Math.max(price, BPS_DENOMINATOR - a);
    }
    if (price < MIN_PRICE_BPS || price > MAX_PRICE_BPS) continue;
    out.push({ ...q, priceBps: price });
  }
  // Never let clamping invert a bot's own spread on either book.
  return out.filter((q) => {
    const opp = out.find((x) => x.outcome === q.outcome && x.side !== q.side);
    if (!opp) return true;
    return q.side === OrderSide.Buy ? q.priceBps < opp.priceBps : q.priceBps > opp.priceBps;
  });
}

/** Turn quotes into book orders for simulation. `seqStart` must exceed every existing seq. */
export function quotesToOrders(quotes: readonly Quote[], seqStart: bigint): Array<BookOrder & { isBot: true }> {
  return quotes.map((q, i) => ({
    id: `${q.bot}-${q.outcome}-${q.side}-${seqStart + BigInt(i)}`,
    maker: `bot-${q.bot}`,
    outcome: q.outcome,
    side: q.side,
    priceBps: q.priceBps,
    remaining: q.size,
    seq: seqStart + BigInt(i),
    isBot: true as const,
  }));
}

/**
 * One requote round: each bot in turn cancels its own orders and posts clamped targets against the
 * current book (the live-worker behaviour). Returns the new book.
 */
export function requoteRound(
  bots: readonly BotParams[],
  book: ReadonlyArray<BookOrder & { isBot: boolean }>,
  netYes: ReadonlyMap<string, bigint>,
  opts: QuoteOptions,
): Array<BookOrder & { isBot: boolean }> {
  let cur = [...book];
  let seq = cur.reduce((m, o) => (o.seq > m ? o.seq : m), 0n) + 1n;
  for (const p of bots) {
    const others = cur.filter((o) => o.maker !== `bot-${p.name}`);
    const posted = clampQuotes(p, targetQuotes(p, netYes.get(p.name) ?? 0n, opts.skewEnabled), others, opts);
    const fresh = quotesToOrders(posted, seq);
    seq += BigInt(fresh.length);
    cur = [...others, ...fresh];
  }
  return cur;
}

/** Cross-book arbitrage across bot quotes: returns violations of `bid_i + bid_j ≤ 10,000` / `ask_i + ask_j ≥ 10,000`. */
export function crossBookArbitrage(book: ReadonlyArray<BookOrder & { isBot: boolean }>): string[] {
  const bots = book.filter((o) => o.isBot);
  const bad: string[] = [];
  for (const y of bots.filter((o) => o.outcome === Outcome.Yes)) {
    for (const n of bots.filter((o) => o.outcome === Outcome.No && o.side === y.side)) {
      const sum = y.priceBps + n.priceBps;
      if (y.side === OrderSide.Buy && sum > BPS_DENOMINATOR) bad.push(`bids ${y.maker}@${y.priceBps} + ${n.maker}@${n.priceBps} = ${sum}`);
      if (y.side === OrderSide.Sell && sum < BPS_DENOMINATOR) bad.push(`asks ${y.maker}@${y.priceBps} + ${n.maker}@${n.priceBps} = ${sum}`);
    }
  }
  return bad;
}
