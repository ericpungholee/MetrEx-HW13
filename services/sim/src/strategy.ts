// Simulated trader decisions (docs/spec-simulation.md §2, §5). Pure: the worker passes chain state
// and a seeded random source and executes the returned action. Six archetypes, each a different
// kind of participant, all trading through the same order book as everyone else.
//
// Prices are compared in log-odds because these markets trade at fractions of a percent; a fixed
// cents edge would mean nothing at 0.1¢ and everything at 99¢. Every price that leaves this module
// is an integer number of basis points and every size an integer number of shares.

import {
  BPS_DENOMINATOR,
  MAX_ORDER_QTY,
  MAX_PRICE_BPS,
  MIN_PRICE_BPS,
  OrderSide,
  Outcome,
  PAYOUT_PER_SHARE,
  QUOTE_PER_SHARE_BPS,
  bpsToLogit,
  logitToBps,
  type OrderAccount,
  type OrderSideCode,
  type OutcomeCode,
} from "@metrex/exchange";
import { quotesOf, type MarketCtx, type Quotes } from "./market";
import type { TraderProfile } from "./population";
import type { Rng } from "./rng";

export interface Holdings {
  /** Free mUSD, base units. */
  musd: bigint;
  /** Free YES and NO shares in this market. */
  yes: bigint;
  no: bigint;
  /** This trader's live orders in this market. */
  own: readonly OrderAccount[];
}

/** Per trader and market, in memory (lost on restart, which only resets holding timers). */
export interface TraderMemory {
  yesEntryLogit?: number;
  noEntryLogit?: number;
  enteredMs?: number;
}

export type SimAction =
  /** Market order: `take_order` up to `MAX_TAKE_LEVELS` levels, each limited to `worstPriceBps`. */
  | { kind: "take"; outcome: OutcomeCode; side: OrderSideCode; qty: bigint; worstPriceBps: number; reason: string }
  /** Resting limit order that does not cross. */
  | { kind: "limit"; outcome: OutcomeCode; side: OrderSideCode; priceBps: number; qty: bigint; ttlS: number; reason: string }
  | { kind: "cancel"; orders: OrderAccount[]; reason: string }
  /** Complement arbitrage: buy YES and NO below 1 mUSD together, then merge. */
  | { kind: "buyMerge"; qty: bigint; yesWorstBps: number; noWorstBps: number; reason: string }
  /** Complement arbitrage: split 1 mUSD into a pair and sell both above 1 mUSD together. */
  | { kind: "splitSell"; qty: bigint; yesWorstBps: number; noWorstBps: number; reason: string }
  /** Underwriting: split 1 mUSD into a pair, sell the YES into a rich bid and keep the NO. */
  | { kind: "underwrite"; qty: bigint; yesWorstBps: number; reason: string };

/** Smallest trade worth sending, mUSD base units. */
export const MIN_NOTIONAL = 5n * PAYOUT_PER_SHARE;
/** Resting limit orders per trader and market (rent float, §4). */
export const MAX_RESTING = 2;

const clampBps = (x: number) => Math.min(MAX_PRICE_BPS, Math.max(MIN_PRICE_BPS, Math.round(x)));
const floorBps = (x: number) => Math.min(MAX_PRICE_BPS, Math.max(MIN_PRICE_BPS, Math.floor(x)));
const ceilBps = (x: number) => Math.min(MAX_PRICE_BPS, Math.max(MIN_PRICE_BPS, Math.ceil(x)));
const costOf = (qty: bigint, bps: number) => qty * BigInt(bps) * QUOTE_PER_SHARE_BPS;
const sharesFor = (budget: bigint, bps: number) => (bps <= 0 ? 0n : budget / (BigInt(bps) * QUOTE_PER_SHARE_BPS));
const minB = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
const lg = bpsToLogit;

/** Trader's belief about YES, log-odds (§2). */
export function beliefLogit(p: TraderProfile, ctx: MarketCtx, rng: Rng): number {
  const market = lg(ctx.midBps ?? ctx.anchorBps);
  const prior = (1 - p.stubbornness) * market + p.stubbornness * lg(ctx.anchorBps);
  return prior + p.bias[ctx.hazard] + p.sensitivity * ctx.signal + rng.normal(0, p.noise);
}

/** Current market value of holdings in this market, base units (YES and NO at mid). */
export function exposure(h: Pick<Holdings, "yes" | "no">, midBps: number): bigint {
  const y = clampBps(midBps);
  return costOf(h.yes, y) + costOf(h.no, BPS_DENOMINATOR - y);
}

/** mUSD this trader will commit to one buy now. */
export function buyBudget(p: TraderProfile, h: Holdings, ctx: MarketCtx, rng: Rng, scale = 1): bigint {
  const frac = rng.uniform(p.tradeFrac[0], p.tradeFrac[1]) * scale;
  const want = BigInt(Math.floor(Number(p.capital) * frac));
  const cap = BigInt(Math.floor(Number(p.capital) * p.maxExposureFrac));
  const used = exposure(h, ctx.midBps ?? ctx.anchorBps);
  const room = cap > used ? cap - used : 0n;
  const b = minB(want, room, h.musd);
  return b >= MIN_NOTIONAL ? b : 0n;
}

const take = (outcome: OutcomeCode, side: OrderSideCode, qty: bigint, worstPriceBps: number, reason: string): SimAction | null =>
  qty > 0n ? { kind: "take", outcome, side, qty, worstPriceBps: clampBps(worstPriceBps), reason } : null;

/** Buy YES at prices up to `capBps` with `budget`. */
function buyYes(q: Quotes, budget: bigint, capBps: number, reason: string): SimAction | null {
  if (!q.yesAsk || budget === 0n) return null;
  const worst = Math.max(q.yesAsk.priceBps, floorBps(capBps));
  const qty = sharesFor(budget, worst);
  return costOf(qty, q.yesAsk.priceBps) >= MIN_NOTIONAL ? take(Outcome.Yes, OrderSide.Buy, qty, worst, reason) : null;
}

/** Buy NO while the YES-equivalent sale price stays at or above `floorYesBps`. */
function buyNo(q: Quotes, budget: bigint, floorYesBps: number, reason: string): SimAction | null {
  if (!q.noAsk || budget === 0n) return null;
  const worst = Math.max(q.noAsk.priceBps, floorBps(BPS_DENOMINATOR - ceilBps(floorYesBps)));
  const qty = sharesFor(budget, worst);
  return costOf(qty, q.noAsk.priceBps) >= MIN_NOTIONAL ? take(Outcome.No, OrderSide.Buy, qty, worst, reason) : null;
}

/** Sell up to `qty` held shares into the bid, accepting `slipFrac` below the best bid. */
function sell(q: Quotes, outcome: OutcomeCode, qty: bigint, slipFrac: number, reason: string): SimAction | null {
  const bid = outcome === Outcome.Yes ? q.yesBid : q.noBid;
  if (!bid || qty <= 0n) return null;
  const worst = floorBps(bid.priceBps - Math.max(1, bid.priceBps * slipFrac));
  return costOf(qty, bid.priceBps) >= MIN_NOTIONAL / 5n ? take(outcome, OrderSide.Sell, qty, worst, reason) : null;
}

/** A non-crossing bid one tick above the best bid on `outcome`'s book, at most `capBps`. */
function improveBid(q: Quotes, outcome: OutcomeCode, capBps: number, budget: bigint, ttlS: number, reason: string): SimAction | null {
  const bid = outcome === Outcome.Yes ? q.yesBid : q.noBid;
  const ask = outcome === Outcome.Yes ? q.yesAsk : q.noAsk;
  let price = bid ? bid.priceBps + 1 : Math.max(MIN_PRICE_BPS, (ask?.priceBps ?? 2) - 1);
  price = Math.min(price, floorBps(capBps));
  if (ask) price = Math.min(price, ask.priceBps - 1);
  if (price < MIN_PRICE_BPS || budget === 0n) return null;
  // place_order accepts at most MAX_ORDER_QTY shares (spec-v2 §5.2).
  const qty = minB(sharesFor(budget, price), MAX_ORDER_QTY);
  return costOf(qty, price) >= MIN_NOTIONAL ? { kind: "limit", outcome, side: OrderSide.Buy, priceBps: price, qty, ttlS, reason } : null;
}

const stale = (o: OrderAccount, chainNow: bigint, ttlS: number) => chainNow - o.createdAt >= BigInt(ttlS);

export interface DecideInput {
  p: TraderProfile;
  /** Trader wallet, base58 (its own orders are excluded from what it can take). */
  me: string;
  ctx: MarketCtx;
  h: Holdings;
  mem: TraderMemory;
  rng: Rng;
  nowMs: number;
}

/** Orders this trader should cancel now regardless of whether it acts (expired lifetime). */
export function staleOrders(i: Pick<DecideInput, "p" | "ctx" | "h">): OrderAccount[] {
  return i.h.own.filter((o) => o.remainingQty > 0n && stale(o, i.ctx.chainNow, i.p.limitTtlS));
}

/** One decision, or null to hold. */
export function decide(i: DecideInput): SimAction | null {
  return capShares(i, decideRaw(i));
}

/**
 * Holding cap (§2): shares held plus resting bids on one outcome never exceed `maxShares`. Buys are
 * trimmed to the room left and dropped below the minimum notional; sells, cancels and complement
 * arbitrage (which ends flat) pass through.
 */
export function capShares(i: Pick<DecideInput, "p" | "h">, a: SimAction | null): SimAction | null {
  if (!a || (a.kind !== "take" && a.kind !== "limit") || a.side !== OrderSide.Buy) return a;
  const held = a.outcome === Outcome.Yes ? i.h.yes : i.h.no;
  const bidding = i.h.own.filter((o) => o.outcome === a.outcome && o.side === OrderSide.Buy).reduce((s, o) => s + o.remainingQty, 0n);
  const room = i.p.maxShares - held - bidding;
  const qty = a.qty < room ? a.qty : room;
  const price = a.kind === "take" ? a.worstPriceBps : a.priceBps;
  if (qty <= 0n || costOf(qty, price) < MIN_NOTIONAL) return null;
  return { ...a, qty };
}

function decideRaw(i: DecideInput): SimAction | null {
  const q = quotesOf(i.ctx.book.filter((o) => o.maker !== i.me));
  const view = { ...i, q };
  switch (i.p.archetype) {
    case "retail":
      return retail(view);
    case "homeowner":
      return homeowner(view);
    case "risk":
      return riskInvestor(view);
    case "quant":
      return quant(view);
    case "momentum":
      return momentum(view);
    case "large":
      return large(view);
  }
}

type View = DecideInput & { q: Quotes };
const heldMin = (v: View) => (v.mem.enteredMs === undefined ? Infinity : (v.nowMs - v.mem.enteredMs) / 60_000);

/** Value entries on both books: the larger log-odds edge above `edge` wins. */
function valueEntry(v: View, L: number, edge: number, budgetScale = 1, label = "value"): SimAction | null {
  const { q } = v;
  const yesEdge = q.yesAsk ? L - lg(q.yesAsk.priceBps) : -Infinity;
  const noEdge = q.noAsk ? lg(BPS_DENOMINATOR - q.noAsk.priceBps) - L : -Infinity;
  if (Math.max(yesEdge, noEdge) <= edge) return null;
  const budget = buyBudget(v.p, v.h, v.ctx, v.rng, budgetScale);
  return yesEdge >= noEdge
    ? buyYes(q, budget, logitToBps(L - edge / 2), `${label}: YES below belief`)
    : buyNo(q, budget, logitToBps(L + edge / 2), `${label}: NO below belief`);
}

/** Take profit or cut losses on a held side. */
function exitOnMove(v: View, gainAt: number, lossAt: number, maxHoldMin: number): SimAction | null {
  const { q, h, mem } = v;
  if (h.yes > 0n && q.yesBid) {
    const g = lg(q.yesBid.priceBps) - (mem.yesEntryLogit ?? lg(q.yesBid.priceBps));
    if (g >= gainAt || g <= -lossAt || heldMin(v) >= maxHoldMin) return sell(q, Outcome.Yes, h.yes, 0.1, g >= gainAt ? "take profit YES" : g <= -lossAt ? "stop loss YES" : "exit YES");
  }
  if (h.no > 0n && q.noBid) {
    // NO gains when the YES-equivalent falls.
    const yesEq = BPS_DENOMINATOR - q.noBid.priceBps;
    const g = (mem.noEntryLogit ?? lg(yesEq)) - lg(yesEq);
    if (g >= gainAt || g <= -lossAt || heldMin(v) >= maxHoldMin) return sell(q, Outcome.No, h.no, 0.002, g >= gainAt ? "take profit NO" : g <= -lossAt ? "stop loss NO" : "exit NO");
  }
  return null;
}

function retail(v: View): SimAction | null {
  return exitOnMove(v, 0.4, 0.7, v.p.holdMin * 3) ?? valueEntry(v, beliefLogit(v.p, v.ctx, v.rng), v.p.edge, 1, "retail");
}

/** Buys YES toward a coverage target, mostly with patient bids, and holds. */
function homeowner(v: View): SimAction | null {
  const { p, q, h } = v;
  const resting = h.own.filter((o) => o.remainingQty > 0n);
  const covered = h.yes + resting.filter((o) => o.outcome === Outcome.Yes && o.side === OrderSide.Buy).reduce((a, o) => a + o.remainingQty, 0n);
  if (covered >= p.coverageShares || resting.length >= MAX_RESTING) return null;
  // Willing to pay a loading above its belief: it is buying protection, not a bet.
  const willing = beliefLogit(p, v.ctx, v.rng) + p.edge;
  const remaining = p.coverageShares - covered;
  const budget = buyBudget(p, h, v.ctx, v.rng);
  if (budget === 0n) return null;
  if (q.yesAsk && lg(q.yesAsk.priceBps) <= willing && !v.rng.chance(p.limitShare)) {
    const worst = Math.max(q.yesAsk.priceBps, floorBps(logitToBps(willing)));
    return take(Outcome.Yes, OrderSide.Buy, minB(remaining, sharesFor(budget, worst)), worst, "coverage: buy YES");
  }
  const bid = improveBid(q, Outcome.Yes, logitToBps(willing), budget, p.limitTtlS, "coverage: YES bid");
  return bid && bid.kind === "limit" ? { ...bid, qty: minB(bid.qty, remaining) } : bid;
}

/**
 * Underwrites a rich YES bid (a homeowner's premium, spec-multiperil §7.7): splits pairs and sells
 * the YES into the bid when it is above belief by `edge`, keeping the NO. The net cost per share is
 * 1 mUSD less the premium received; the NO held stays under the holding cap.
 */
export function underwrite(v: Pick<View, "p" | "q" | "h" | "ctx" | "rng">, L: number): SimAction | null {
  const { p, q, h } = v;
  if (!q.yesBid || lg(q.yesBid.priceBps) - L <= p.edge) return null;
  const net = PAYOUT_PER_SHARE - costOf(1n, q.yesBid.priceBps);
  const budget = buyBudget(p, h, v.ctx, v.rng);
  const room = p.maxShares - h.no;
  const qty = minB(q.yesBid.remaining, net > 0n ? budget / net : 0n, room > 0n ? room : 0n, MAX_ORDER_QTY);
  if (qty <= 0n || qty * net < MIN_NOTIONAL) return null;
  return { kind: "underwrite", qty, yesWorstBps: q.yesBid.priceBps, reason: "risk: underwrite YES bid" };
}

/** Sells risk: underwrites rich YES bids, accumulates NO when YES looks rich, posts NO bids, exits when YES looks cheap. */
function riskInvestor(v: View): SimAction | null {
  const { p, q, h } = v;
  const L = beliefLogit(p, v.ctx, v.rng);
  const uw = underwrite(v, L);
  if (uw) return uw;
  if (h.no > 0n && q.noBid && L - lg(BPS_DENOMINATOR - q.noBid.priceBps) > p.edge) return sell(q, Outcome.No, h.no / 2n || h.no, 0.002, "risk: YES now cheap, reduce NO");
  if (q.noAsk && lg(BPS_DENOMINATOR - q.noAsk.priceBps) - L > p.edge && !v.rng.chance(p.limitShare)) {
    return buyNo(q, buyBudget(p, h, v.ctx, v.rng), logitToBps(L + p.edge / 2), "risk: sell YES via NO");
  }
  if (h.own.filter((o) => o.remainingQty > 0n).length >= MAX_RESTING) return null;
  // A NO bid at b sells YES at 10,000 − b: post it only if that is above belief + edge.
  const capNo = BPS_DENOMINATOR - ceilBps(logitToBps(L + p.edge));
  return improveBid(q, Outcome.No, capNo, buyBudget(p, h, v.ctx, v.rng), p.limitTtlS, "risk: NO bid");
}

function quant(v: View): SimAction | null {
  const { p, q, h } = v;
  // Complement arbitrage first (both legs and the merge or split in one transaction).
  if (q.yesAsk && q.noAsk && q.yesAsk.priceBps + q.noAsk.priceBps < BPS_DENOMINATOR) {
    const per = BigInt(q.yesAsk.priceBps + q.noAsk.priceBps) * QUOTE_PER_SHARE_BPS;
    const qty = minB(q.yesAsk.remaining, q.noAsk.remaining, h.musd / per);
    if (qty * per >= MIN_NOTIONAL) return { kind: "buyMerge", qty, yesWorstBps: q.yesAsk.priceBps, noWorstBps: q.noAsk.priceBps, reason: "arb: YES + NO asks < 1" };
  }
  if (q.yesBid && q.noBid && q.yesBid.priceBps + q.noBid.priceBps > BPS_DENOMINATOR) {
    const qty = minB(q.yesBid.remaining, q.noBid.remaining, h.musd / PAYOUT_PER_SHARE);
    if (qty * PAYOUT_PER_SHARE >= MIN_NOTIONAL) return { kind: "splitSell", qty, yesWorstBps: q.yesBid.priceBps, noWorstBps: q.noBid.priceBps, reason: "arb: YES + NO bids > 1" };
  }
  const L = beliefLogit(p, v.ctx, v.rng);
  if (h.yes > 0n && q.yesBid && lg(q.yesBid.priceBps) - L > p.edge) return sell(q, Outcome.Yes, h.yes, 0.02, "quant: YES rich, sell");
  if (h.no > 0n && q.noBid && L - lg(BPS_DENOMINATOR - q.noBid.priceBps) > p.edge) return sell(q, Outcome.No, h.no, 0.001, "quant: NO rich, sell");
  const strong = valueEntry(v, L, 2 * p.edge, 1, "quant");
  if (strong) return strong;
  if (!v.rng.chance(p.limitShare) || h.own.filter((o) => o.remainingQty > 0n).length >= MAX_RESTING) return null;
  // Provide liquidity inside a wide spread, on whichever book is further from fair value.
  const budget = buyBudget(p, h, v.ctx, v.rng);
  const yesCap = logitToBps(L - p.edge);
  const noCap = BPS_DENOMINATOR - ceilBps(logitToBps(L + p.edge));
  const wideYes = q.yesBid && q.yesAsk && q.yesAsk.priceBps - q.yesBid.priceBps >= 3;
  const wideNo = q.noBid && q.noAsk && q.noAsk.priceBps - q.noBid.priceBps >= 3;
  if (wideYes && v.rng.chance(0.5)) return improveBid(q, Outcome.Yes, yesCap, budget, p.limitTtlS, "quant: YES bid inside spread");
  if (wideNo) return improveBid(q, Outcome.No, noCap, budget, p.limitTtlS, "quant: NO bid inside spread");
  return null;
}

function momentum(v: View): SimAction | null {
  const { p, q, h } = v;
  if ((h.yes > 0n || h.no > 0n) && heldMin(v) >= p.holdMin) return exitOnMove(v, 0, 0, 0);
  const r = v.ctx.momentum(p.momentumWindowMin);
  if (r === undefined || Math.abs(r) < p.momentumThreshold) return null;
  const budget = buyBudget(p, h, v.ctx, v.rng);
  if (r > 0) {
    if (h.no > 0n) return sell(q, Outcome.No, h.no, 0.002, "momentum: YES rising, exit NO");
    return q.yesAsk ? buyYes(q, budget, q.yesAsk.priceBps * 1.15, "momentum: YES rising") : null;
  }
  if (h.yes > 0n) return sell(q, Outcome.Yes, h.yes, 0.1, "momentum: YES falling, exit YES");
  return q.noAsk ? buyNo(q, budget, (BPS_DENOMINATOR - q.noAsk.priceBps) * 0.85, "momentum: YES falling") : null;
}

/** Rare, large sweeps that consume several levels. */
function large(v: View): SimAction | null {
  const { p, q } = v;
  const exit = exitOnMove(v, 0.3, 0.6, p.holdMin * 4);
  if (exit) return exit;
  const L = beliefLogit(p, v.ctx, v.rng);
  const mid = lg(v.ctx.midBps ?? v.ctx.anchorBps);
  if (Math.abs(L - mid) < p.edge) return null;
  const budget = buyBudget(p, v.h, v.ctx, v.rng);
  // Price-insensitive within its belief: sweeps up to half a log-odds unit past the touch.
  if (L > mid) return q.yesAsk ? buyYes(q, budget, Math.min(logitToBps(L), logitToBps(lg(q.yesAsk.priceBps) + 0.5)), "large: sweep YES") : null;
  return q.noAsk ? buyNo(q, budget, Math.max(logitToBps(L), logitToBps(lg(BPS_DENOMINATOR - q.noAsk.priceBps) - 0.5)), "large: sweep NO") : null;
}

/** Updates memory after a confirmed entry or exit. */
export function remember(mem: TraderMemory, a: SimAction, avgPriceBps: number | undefined, nowMs: number): TraderMemory {
  if (a.kind !== "take" || avgPriceBps === undefined) return mem;
  const next = { ...mem };
  if (a.side === OrderSide.Buy) {
    if (a.outcome === Outcome.Yes) next.yesEntryLogit = lg(avgPriceBps);
    else next.noEntryLogit = lg(BPS_DENOMINATOR - avgPriceBps);
    next.enteredMs = nowMs;
  }
  return next;
}
