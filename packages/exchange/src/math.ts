// Exact integer money math (spec-v2 §3, §4.6). FROZEN at Gate V0. Mirrors the program.

import {
  INVALID_PAYOUT_PER_SHARE,
  MAX_PRICE_BPS,
  MIN_PRICE_BPS,
  PAYOUT_PER_SHARE,
  QUOTE_PER_SHARE_BPS,
} from "./constants";

export type MarketOutcomeName = "unresolved" | "yes" | "no" | "invalid";

export function assertPrice(priceBps: number): void {
  if (!Number.isInteger(priceBps) || priceBps < MIN_PRICE_BPS || priceBps > MAX_PRICE_BPS) {
    throw new RangeError(`price out of range: ${priceBps}`);
  }
}

/** `quote = quantity × price_bps × 100` base units. Exact; no rounding exists. */
export function quote(quantity: bigint, priceBps: number): bigint {
  assertPrice(priceBps);
  if (quantity < 0n) throw new RangeError("negative quantity");
  return quantity * BigInt(priceBps) * QUOTE_PER_SHARE_BPS;
}

/** mUSD needed to split `q` pairs. */
export const splitAmount = (q: bigint): bigint => q * PAYOUT_PER_SHARE;

/** Base units paid per share of `side` (0 YES, 1 NO) for a resolved market; 0 for losing shares. */
export function payoutPerShare(outcome: MarketOutcomeName, side: 0 | 1): bigint {
  switch (outcome) {
    case "yes":
      return side === 0 ? PAYOUT_PER_SHARE : 0n;
    case "no":
      return side === 1 ? PAYOUT_PER_SHARE : 0n;
    case "invalid":
      return INVALID_PAYOUT_PER_SHARE;
    default:
      return 0n;
  }
}

/** Booked obligation `O` of a market vault (§4.6, invariant I1). Require `vault ≥ O`. */
export function vaultObligation(s: {
  outcome: MarketOutcomeName;
  pairsOutstanding: bigint;
  yesSupply: bigint;
  noSupply: bigint;
}): bigint {
  switch (s.outcome) {
    case "unresolved":
      return s.pairsOutstanding * PAYOUT_PER_SHARE;
    case "yes":
      return s.yesSupply * PAYOUT_PER_SHARE;
    case "no":
      return s.noSupply * PAYOUT_PER_SHARE;
    case "invalid":
      return (s.yesSupply + s.noSupply) * INVALID_PAYOUT_PER_SHARE;
  }
}
