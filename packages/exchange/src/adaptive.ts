// Adaptive market-maker reference (docs/spec-simulation.md §3). Policy code, not frozen. Pure: no I/O.
//
// The catalog ladder initialises a market; observed fills, signed taker flow, the makers' own
// independent estimate (the catalog reference, with slow reversion) and recent volatility move it.
// Prices are tracked in log-odds as JS numbers. This is off-chain policy only: the program never
// sees a float, and every quote that leaves here is an integer number of basis points.

import { BPS_DENOMINATOR, MAX_PRICE_BPS, MIN_PRICE_BPS, OrderSide, Outcome, type OrderSideCode, type OutcomeCode } from "./constants";
import type { BotParams } from "./ladder";
import type { OrderAccount } from "./projection";

/** A fill seen as a `remaining_qty` decrease of a resting order between two account reads. */
export interface ObservedFill {
  order: string;
  outcome: OutcomeCode;
  /** Side of the order that was filled. */
  side: OrderSideCode;
  /** The order's own price (execution happens at the older order's price, spec-v2 §5). */
  priceBps: number;
  qty: bigint;
}

/** Fills between two reads of one market's Order accounts. Orders that vanished were cancelled or swept, not filled. */
export function diffFills(prev: readonly OrderAccount[], cur: readonly OrderAccount[]): ObservedFill[] {
  const before = new Map(prev.map((o) => [o.address, o]));
  const out: ObservedFill[] = [];
  for (const o of cur) {
    const p = before.get(o.address);
    if (!p || o.remainingQty >= p.remainingQty) continue;
    out.push({ order: o.address, outcome: o.outcome, side: o.side, priceBps: o.priceBps, qty: p.remainingQty - o.remainingQty });
  }
  return out;
}

/** YES-equivalent price of a fill (NO price p ↔ YES 10,000 − p). */
export const yesEquivalentBps = (f: Pick<ObservedFill, "outcome" | "priceBps">): number =>
  f.outcome === Outcome.Yes ? f.priceBps : BPS_DENOMINATOR - f.priceBps;

/**
 * +1 when the fill pushed YES up (a resting YES ask or NO bid was hit), −1 otherwise. A keeper
 * match decreases both a bid and an ask, so its two halves cancel out.
 */
export const takerFlowSign = (f: Pick<ObservedFill, "outcome" | "side">): 1 | -1 =>
  (f.outcome === Outcome.Yes) === (f.side === OrderSide.Sell) ? 1 : -1;

export const logit = (p: number): number => Math.log(p / (1 - p));
export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
export const bpsToLogit = (bps: number): number => logit(Math.min(MAX_PRICE_BPS, Math.max(MIN_PRICE_BPS, bps)) / BPS_DENOMINATOR);
export const logitToBps = (x: number): number => sigmoid(x) * BPS_DENOMINATOR;

export interface AdaptiveConfig {
  /** Weight of the volume-weighted fill price per unit of `1 − exp(−volume / depthShares)`. */
  tradeWeight: number;
  /** Log-odds moved by one `depthShares` of net taker flow. */
  flowImpact: number;
  /** Half-life of reversion toward the makers' own estimate, minutes. */
  anchorHalfLifeMin: number;
  /** Largest relative price move per step. */
  maxStepFrac: number;
  /** The mid stays within anchor / band … anchor × band. */
  anchorBand: number;
  /** Volatility (sum of |Δ log-odds|) that adds 1× to the spread; decays with `volHalfLifeMin`. */
  volRef: number;
  volHalfLifeMin: number;
  /** Largest spread multiplier. */
  maxSpreadMult: number;
  /** Republish the mid only when it moved at least this fraction … */
  deadbandFrac: number;
  /** … or at least this many bps. */
  deadbandBps: number;
}

export const DEFAULT_ADAPTIVE: AdaptiveConfig = {
  tradeWeight: 0.5,
  flowImpact: 0.15,
  anchorHalfLifeMin: 45,
  maxStepFrac: 0.12,
  anchorBand: 10,
  volRef: 0.2,
  volHalfLifeMin: 10,
  maxSpreadMult: 3,
  deadbandFrac: 0.025,
  deadbandBps: 0.75,
};

export interface AdaptiveState {
  /** Makers' independent estimate: the catalog reference of maker A, bps. */
  anchorBps: number;
  /** Current mid, bps (fractional). */
  midBps: number;
  /** The mid quotes are built from; moves only past the dead band. */
  publishedBps: number;
  /** Decaying sum of |Δ log-odds|. */
  vol: number;
  updatedMs: number;
  /** Fills folded in so far (diagnostics). */
  fills: number;
}

export function initAdaptive(anchorBps: number, nowMs: number, fromBookBps?: number): AdaptiveState {
  const start = fromBookBps !== undefined && Number.isFinite(fromBookBps) && fromBookBps > 0 ? fromBookBps : anchorBps;
  return { anchorBps, midBps: start, publishedBps: start, vol: 0, updatedMs: nowMs, fills: 0 };
}

const decay = (dtMs: number, halfLifeMin: number) => (halfLifeMin <= 0 ? 0 : Math.pow(0.5, dtMs / (halfLifeMin * 60_000)));

/** One update from the fills observed since the last step. */
export function stepAdaptive(
  s: AdaptiveState,
  fills: readonly ObservedFill[],
  nowMs: number,
  depthShares: bigint,
  cfg: AdaptiveConfig = DEFAULT_ADAPTIVE,
): AdaptiveState {
  const dt = Math.max(0, nowMs - s.updatedMs);
  const depth = Number(depthShares > 0n ? depthShares : 1n);
  let x = bpsToLogit(s.midBps);
  const start = x;

  // 1. Pull toward the volume-weighted fill price.
  let vol = 0;
  let pxVol = 0;
  let signed = 0;
  for (const f of fills) {
    const q = Number(f.qty);
    vol += q;
    pxVol += q * bpsToLogit(yesEquivalentBps(f));
    signed += q * takerFlowSign(f);
  }
  if (vol > 0) {
    const alpha = cfg.tradeWeight * (1 - Math.exp(-vol / depth));
    x += alpha * (pxVol / vol - x);
    // 2. Signed taker flow: lifting asks raises the mid, hitting bids lowers it.
    x += cfg.flowImpact * Math.tanh(signed / depth);
  }
  // 3. Slow reversion toward the makers' own estimate.
  const anchor = bpsToLogit(s.anchorBps);
  x = anchor + (x - anchor) * decay(dt, cfg.anchorHalfLifeMin);

  // 4. Bounded step and band.
  let mid = logitToBps(x);
  mid = Math.min(s.midBps * (1 + cfg.maxStepFrac), Math.max(s.midBps * (1 - cfg.maxStepFrac), mid));
  mid = Math.min(s.anchorBps * cfg.anchorBand, Math.max(s.anchorBps / cfg.anchorBand, mid));
  mid = Math.min(MAX_PRICE_BPS - 1, Math.max(MIN_PRICE_BPS, mid));

  // 5. Volatility for spread widening.
  const v = s.vol * decay(dt, cfg.volHalfLifeMin) + Math.abs(bpsToLogit(mid) - start);

  const moved = Math.abs(mid - s.publishedBps);
  const published = moved >= Math.max(cfg.deadbandBps, cfg.deadbandFrac * s.publishedBps) ? mid : s.publishedBps;
  return { anchorBps: s.anchorBps, midBps: mid, publishedBps: published, vol: v, updatedMs: nowMs, fills: s.fills + fills.length };
}

export function spreadMultiplier(s: Pick<AdaptiveState, "vol">, cfg: AdaptiveConfig = DEFAULT_ADAPTIVE): number {
  return Math.min(cfg.maxSpreadMult, 1 + s.vol / cfg.volRef);
}

/**
 * One maker's parameters around the published mid. `refA` is maker A's catalog reference: bot i
 * keeps its catalog ratio to A, so the ladder's shape survives the move. Skew is enabled with
 * `skew_max` equal to the half-spread.
 */
export function adaptiveParams(base: BotParams, refA: number, s: AdaptiveState, cfg: AdaptiveConfig = DEFAULT_ADAPTIVE): BotParams {
  const scale = s.publishedBps / refA;
  const half = Math.max(1, Math.round(base.halfSpreadBps * scale * spreadMultiplier(s, cfg)));
  let ref = Math.round(base.refBps * scale);
  ref = Math.max(ref, MIN_PRICE_BPS + half);
  ref = Math.min(ref, MAX_PRICE_BPS - half);
  return { ...base, refBps: ref, halfSpreadBps: half, skewMaxBps: half };
}

/** Maker A's quoted YES mid from its own resting YES bid and ask (restart recovery), if both rest. */
export function restingMid(orders: readonly OrderAccount[], maker: string): number | undefined {
  const live = orders.filter((o) => o.maker === maker && o.outcome === Outcome.Yes && o.remainingQty > 0n);
  const bid = live.filter((o) => o.side === OrderSide.Buy).map((o) => o.priceBps);
  const ask = live.filter((o) => o.side === OrderSide.Sell).map((o) => o.priceBps);
  if (!bid.length || !ask.length) return undefined;
  return (Math.max(...bid) + Math.min(...ask)) / 2;
}
