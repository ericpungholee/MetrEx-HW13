// v2 market-maker decisions (spec-v2 §8). Pure: the worker feeds in chain state and executes the
// returned actions. Prices come from the tested ladder in @metrex/exchange (targetQuotes,
// clampQuotes); this module adds inventory, sizing, requote thresholds and lifecycle.
//
// Inventory is always read from actual token balances plus this bot's own escrows, never from
// assumed fills (§8.1). Bots are post-only and never cross the book (§8.2, clampQuotes).

import {
  BPS_DENOMINATOR,
  OrderSide,
  Outcome,
  PAYOUT_PER_SHARE,
  QUOTE_PER_SHARE_BPS,
  clampQuotes,
  targetQuotes,
  type BookOrder,
  type BotParams,
  type OrderAccount,
  type OutcomeCode,
  type Quote,
} from "@metrex/exchange";

export interface BotConfig {
  /** Pairs to split when share inventory runs below one top size (§8.1). */
  splitPairs: bigint;
  /** Never let free mUSD fall below this after a split (keeps bids funded). */
  musdReserve: bigint;
  /** Minimum time between requotes of one market by one bot. */
  cooldownMs: number;
  /** §8.1: at most this many orders per market (one per book and side). */
  maxOrders: number;
  /**
   * Stop splitting once either side holds (topSize + splitPairs) × this. Free mUSD bounds splits
   * too, so a larger multiple only lets a funded maker keep offering YES through one-sided flow
   * (docs/spec-simulation.md §3).
   */
  inventoryMult: bigint;
  /**
   * Skip a quote smaller than topSize / this. A dust order at the best price hides the deeper
   * book behind the fixed 5% market-order tolerance (spec-multiperil §7.4), so a 10-share market
   * buy fills 1 share. A maker that cannot fund a real size leaves the level to the next maker
   * (docs/spec-simulation.md §3).
   */
  minQuoteFraction: bigint;
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  splitPairs: 2_000n,
  musdReserve: 1_000n * PAYOUT_PER_SHARE,
  cooldownMs: 1_500,
  maxOrders: 4,
  inventoryMult: 2n,
  minQuoteFraction: 10n,
};

export interface Balances {
  musd: bigint;
  yes: bigint;
  no: bigint;
}

export type MarketPhase = "trading" | "closed" | "resolved_yes" | "resolved_no" | "resolved_invalid";

export interface BotMarketInput {
  params: BotParams;
  config: BotConfig;
  /** Bot wallet, base58. */
  maker: string;
  phase: MarketPhase;
  /** Featured market: skew off (§8.3). */
  featured: boolean;
  /** Free wallet balances (not in escrow). */
  balances: Balances;
  /** Every Order account of this bot in this market, including filled ones (remaining 0). */
  own: readonly OrderAccount[];
  /** Active orders of everyone else in this market; `isBot` marks sibling bots. */
  others: ReadonlyArray<BookOrder & { isBot: boolean }>;
  nowMs: number;
  lastRequoteMs: number | undefined;
  strictPostOnly?: boolean;
  /** Limit on booked bids plus inventory valued at full payout, in mUSD base units. */
  marketCapital?: bigint;
}

export type BotAction =
  | { kind: "split"; quantity: bigint }
  /** One atomic transaction: cancel `cancel` (if any), then place `place` (if any). */
  | { kind: "requote"; cancel: OrderAccount | null; place: Quote | null; reason: string }
  | { kind: "cancel"; orders: OrderAccount[]; reason: string }
  | { kind: "merge"; quantity: bigint }
  | { kind: "redeem"; outcome: OutcomeCode; quantity: bigint };

const slotKey = (outcome: number, side: number) => `${outcome}:${side}`;
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const positive = (amount: bigint) => amount > 0n ? amount : 0n;
const bidValue = (priceBps: number, size: bigint) => size * BigInt(priceBps) * QUOTE_PER_SHARE_BPS;

/** YES and NO held, including shares escrowed in this bot's SELL orders. */
export function inventory(b: Balances, own: readonly OrderAccount[]) {
  let yes = b.yes;
  let no = b.no;
  let musd = b.musd;
  for (const o of own) {
    if (o.side === OrderSide.Sell) {
      if (o.outcome === Outcome.Yes) yes += o.remainingQty;
      else no += o.remainingQty;
    } else {
      musd += bidValue(o.priceBps, o.remainingQty);
    }
  }
  return { yes, no, musd, netYes: yes - no };
}

/** Booked bid collateral plus a conservative full-payout value of outcome inventory. */
export function committedCapital(balances: Balances, own: readonly OrderAccount[]): bigint {
  const inv = inventory(balances, own);
  const largestPosition = inv.yes > inv.no ? inv.yes : inv.no;
  return inv.musd - balances.musd + largestPosition * PAYOUT_PER_SHARE;
}

/** Cash this group can debit before any independent cancellation or merge confirms. */
export function collateralSpend(actions: readonly BotAction[]): bigint {
  let spend = 0n;
  for (const action of actions) {
    if (action.kind === "split") spend += action.quantity * PAYOUT_PER_SHARE;
    if (action.kind !== "requote" || action.place?.side !== OrderSide.Buy) continue;
    const returned = action.cancel ? bidValue(action.cancel.priceBps, action.cancel.remainingQty) : 0n;
    spend += positive(bidValue(action.place.priceBps, action.place.size) - returned);
  }
  return spend;
}

function freeToCommit(i: BotMarketInput, reserve: bigint): bigint {
  const liquid = positive(i.balances.musd - reserve);
  if (i.marketCapital === undefined) return liquid;
  return min(liquid, positive(i.marketCapital - committedCapital(i.balances, i.own)));
}

/**
 * Inventory limit by dropping levels, never by moving prices (§8.2 step 1): past the tolerance,
 * drop the levels that would grow the exposure further.
 */
export function inventoryAllows(q: Pick<Quote, "outcome" | "side">, netYes: bigint, tolerance: bigint): boolean {
  // Net YES rises with: buying YES, selling NO.
  const raisesYes = (q.outcome === Outcome.Yes) === (q.side === OrderSide.Buy);
  if (netYes >= tolerance && raisesYes) return false;
  if (netYes <= -tolerance && !raisesYes) return false;
  return true;
}

/** Requote when the price differs by ≥ 1 tick or the size by ≥ 10% (§8.1). */
export function needsRequote(existing: Pick<OrderAccount, "priceBps" | "remainingQty">, target: Pick<Quote, "priceBps" | "size">): boolean {
  if (existing.priceBps !== target.priceBps) return true;
  const diff = existing.remainingQty > target.size ? existing.remainingQty - target.size : target.size - existing.remainingQty;
  return diff * 10n >= target.size;
}

/** Desired quotes after skew, complement NO, post-only clamp, inventory limits and funding. */
export function desiredQuotes(i: BotMarketInput): Quote[] {
  const inv = inventory(i.balances, i.own);
  const targets = targetQuotes(i.params, inv.netYes, !i.featured);
  const liveOwn = i.own.filter((o) => o.remainingQty > 0n).map((o) => ({
    id: o.address, maker: o.maker, outcome: o.outcome, side: o.side, priceBps: o.priceBps,
    remaining: o.remainingQty, seq: o.seq, isBot: true,
  }));
  const clamped = clampQuotes(i.params, targets, [...i.others, ...liveOwn], {
    skewEnabled: !i.featured,
    ...(i.strictPostOnly ? { respectMinQty: 1n, respectBandBps: BPS_DENOMINATOR } : {}),
  });
  let musdLeft = freeToCommit(i, i.marketCapital === undefined ? 0n : i.config.musdReserve);
  const out: Quote[] = [];
  for (const q of clamped) {
    if (!inventoryAllows(q, inv.netYes, i.params.toleranceShares)) continue;
    const raisesYes = (q.outcome === Outcome.Yes) === (q.side === OrderSide.Buy);
    const room = i.params.toleranceShares - (raisesYes ? inv.netYes : -inv.netYes);
    // Two orders can add the same exposure (for example, a YES bid and a NO ask).
    let size = min(q.size, room / 2n);
    if (q.side === OrderSide.Sell) {
      size = min(size, q.outcome === Outcome.Yes ? inv.yes : inv.no);
    } else {
      const per = BigInt(q.priceBps) * QUOTE_PER_SHARE_BPS;
      // Only the oldest order in this slot can fund its own atomic replacement.
      const ownBid = i.own.reduce<OrderAccount | undefined>((oldest, o) =>
        o.outcome === q.outcome && o.side === q.side && (!oldest || o.seq < oldest.seq) ? o : oldest, undefined);
      const returned = ownBid ? bidValue(ownBid.priceBps, ownBid.remainingQty) : 0n;
      size = min(size, (musdLeft + returned) / per);
      musdLeft -= positive(size * per - returned);
    }
    if (size <= 0n || size * i.config.minQuoteFraction < i.params.topSize) continue;
    out.push({ ...q, size });
  }
  return out.slice(0, i.config.maxOrders);
}

/** Pairs to split now (0 if none): when either side can't cover one top size, funded from free mUSD. */
export function splitNeeded(i: BotMarketInput): bigint {
  const inv = inventory(i.balances, i.own);
  if (inv.yes >= i.params.topSize && inv.no >= i.params.topSize) return 0n;
  const free = freeToCommit(i, i.config.musdReserve);
  const held = inv.yes > inv.no ? inv.yes : inv.no;
  const limit = (i.params.topSize + i.config.splitPairs) * i.config.inventoryMult;
  if (held >= limit) return 0n;
  return min(min(i.config.splitPairs, limit - held), free / PAYOUT_PER_SHARE);
}

export function planBotMarket(i: BotMarketInput): BotAction[] {
  const actions: BotAction[] = [];
  const live = i.own;

  if (i.phase !== "trading") {
    // After close: cancel own orders (cancel works in any state), merge leftover pairs while
    // Unresolved; after resolution: redeem winners (§8.1). Cancels land first; the next tick
    // sees the returned shares.
    if (live.length) return [{ kind: "cancel", orders: [...live], reason: i.phase }];
    if (i.phase === "closed") {
      const pairs = min(i.balances.yes, i.balances.no);
      if (pairs > 0n) actions.push({ kind: "merge", quantity: pairs });
      return actions;
    }
    const redeem = (outcome: OutcomeCode, q: bigint) => q > 0n && actions.push({ kind: "redeem", outcome, quantity: q });
    if (i.phase === "resolved_yes") redeem(Outcome.Yes, i.balances.yes);
    if (i.phase === "resolved_no") redeem(Outcome.No, i.balances.no);
    if (i.phase === "resolved_invalid") {
      redeem(Outcome.Yes, i.balances.yes);
      redeem(Outcome.No, i.balances.no);
    }
    return actions;
  }

  // Retain one top size plus half a split batch, including resting asks. This leaves
  // room for a normal refill without immediately triggering a merge.
  if (i.marketCapital !== undefined && (i.lastRequoteMs === undefined || i.nowMs - i.lastRequoteMs >= i.config.cooldownMs)) {
    const inv = inventory(i.balances, live);
    const paired = min(inv.yes, inv.no);
    const keep = i.params.topSize + i.config.splitPairs / 2n;
    const merge = min(min(i.balances.yes, i.balances.no), positive(paired - keep));
    if (merge > 0n && merge * 2n >= i.config.splitPairs) {
      return [{ kind: "merge", quantity: merge }];
    }
  }

  const split = splitNeeded(i);
  if (split > 0n) {
    // Split first, then quote on the post-split balances in the same tick: the worker sends the split
    // and the asks (which escrow the new shares) in one transaction, so entering a market costs one
    // confirmation instead of two plus a cooldown.
    actions.push({ kind: "split", quantity: split });
    if (i.lastRequoteMs !== undefined && i.nowMs - i.lastRequoteMs < i.config.cooldownMs) return actions;
    const after: BotMarketInput = {
      ...i,
      balances: { musd: i.balances.musd - split * PAYOUT_PER_SHARE, yes: i.balances.yes + split, no: i.balances.no + split },
    };
    return [...actions, ...planQuotes(after)];
  }

  if (i.lastRequoteMs !== undefined && i.nowMs - i.lastRequoteMs < i.config.cooldownMs) return [];
  return planQuotes(i);
}

/** Requotes for the trading phase: keep orders on target, replace stale ones, place missing ones. */
function planQuotes(i: BotMarketInput): BotAction[] {
  const actions: BotAction[] = [];
  const live = i.own;

  const want = new Map(desiredQuotes(i).map((q) => [slotKey(q.outcome, q.side), q]));
  const have = new Map<string, OrderAccount[]>();
  for (const o of live) {
    const k = slotKey(o.outcome, o.side);
    have.set(k, [...(have.get(k) ?? []), o]);
  }
  for (const outcome of [Outcome.Yes, Outcome.No] as const) {
    for (const side of [OrderSide.Buy, OrderSide.Sell] as const) {
      const k = slotKey(outcome, side);
      const target = want.get(k) ?? null;
      const mine = [...(have.get(k) ?? [])].sort((a, b) => (a.seq < b.seq ? -1 : 1));
      const keep = mine.find((o) => o.remainingQty > 0n && target && !needsRequote(o, target));
      for (const o of mine) {
        if (o === keep) continue;
        // Replace the first stale order atomically with the target; cancel any extras.
        const placeHere = target && !keep && !actions.some((a) => a.kind === "requote" && a.place === target);
        actions.push({ kind: "requote", cancel: o, place: placeHere ? target : null, reason: placeHere ? "requote" : "extra" });
      }
      if (target && !keep && mine.length === 0) actions.push({ kind: "requote", cancel: null, place: target, reason: "new" });
    }
  }
  return actions;
}

/** Applies a bot's executed actions to a book snapshot so the next bot in the same tick sees them. */
export function applyToSnapshot(
  book: ReadonlyArray<BookOrder & { isBot: boolean }>,
  maker: string,
  cancelled: readonly string[],
  placed: ReadonlyArray<{ id: string; quote: Quote }>,
  seqStart: bigint,
): Array<BookOrder & { isBot: boolean }> {
  const gone = new Set(cancelled);
  const out = book.filter((o) => !gone.has(o.id));
  placed.forEach((p, n) =>
    out.push({ id: p.id, maker, outcome: p.quote.outcome, side: p.quote.side, priceBps: p.quote.priceBps, remaining: p.quote.size, seq: seqStart + BigInt(n), isBot: true }),
  );
  return out;
}

/** Sanity: a bot's own quotes never offer split-and-sell or buy-and-merge (§8.2 step 3). */
export function ownComplementOk(quotes: readonly Quote[]): boolean {
  const px = (o: number, s: number) => quotes.find((q) => q.outcome === o && q.side === s)?.priceBps;
  const yb = px(Outcome.Yes, OrderSide.Buy);
  const nb = px(Outcome.No, OrderSide.Buy);
  const ya = px(Outcome.Yes, OrderSide.Sell);
  const na = px(Outcome.No, OrderSide.Sell);
  if (yb !== undefined && nb !== undefined && yb + nb > BPS_DENOMINATOR) return false;
  if (ya !== undefined && na !== undefined && ya + na < BPS_DENOMINATOR) return false;
  return true;
}
