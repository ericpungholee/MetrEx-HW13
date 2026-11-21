// Off-chain mirror of the on-chain offer math (spec §4.2), for UI previews and bots.
// The program is authoritative; this must produce identical results.

import { BPS_DENOMINATOR, MAX_BPS, MIN_BPS } from "./constants";

export interface OfferTerms {
  coverage: bigint;
  premium: bigint;
  collateral: bigint;
}

/** premium = floor(coverage × bps / 10_000); collateral = coverage − premium. */
export function computeOfferTerms(coverage: bigint, premiumBps: number): OfferTerms {
  if (!Number.isInteger(premiumBps) || premiumBps < MIN_BPS || premiumBps > MAX_BPS) {
    throw new RangeError(`premiumBps must be an integer in [${MIN_BPS}, ${MAX_BPS}]`);
  }
  if (coverage < 0n) {
    throw new RangeError("coverage must be non-negative");
  }
  const premium = (coverage * BigInt(premiumBps)) / BPS_DENOMINATOR;
  return { coverage, premium, collateral: coverage - premium };
}
