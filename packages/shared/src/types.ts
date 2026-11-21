// TS mirrors of the on-chain accounts (spec §5) as decoded by the Anchor TS client
// (camelCase fields; u64/i64 → BN; [u8; 32] → number[]; enums → `{ variant: {} }`).
// FROZEN after Gate 0.

import type { BN } from "@anchor-lang/core";
import type { PublicKey } from "@solana/web3.js";

// ---------- Enums ----------

export const MARKET_STATUSES = ["open", "closed", "resolvedYes", "resolvedNo", "voided"] as const;
export type MarketStatus = (typeof MARKET_STATUSES)[number];
/** Anchor's decoded form, e.g. `{ open: {} }`. */
export type MarketStatusRaw = { [K in MarketStatus]: { [P in K]: Record<string, never> } }[MarketStatus];

export const OFFER_STATUSES = ["open", "accepted", "cancelled", "claimed", "refunded"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];
export type OfferStatusRaw = { [K in OfferStatus]: { [P in K]: Record<string, never> } }[OfferStatus];

function variantOf<T extends string>(raw: object, allowed: readonly T[]): T {
  const keys = Object.keys(raw);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined || !(allowed as readonly string[]).includes(key)) {
    throw new Error(`Unknown enum variant: ${JSON.stringify(raw)}`);
  }
  return key as T;
}

export function marketStatusOf(raw: MarketStatusRaw): MarketStatus {
  return variantOf(raw, MARKET_STATUSES);
}

export function offerStatusOf(raw: OfferStatusRaw): OfferStatus {
  return variantOf(raw, OFFER_STATUSES);
}

// ---------- Accounts ----------

/** `["config"]` (§5.1) */
export interface ConfigAccount {
  admin: PublicKey;
  oracleAuthority: PublicKey;
  demoController: PublicKey;
  mint: PublicKey;
  bump: number;
}

/** `["property", property_id]` (§5.2) */
export interface PropertyAccount {
  propertyId: number;
  label: number[];
  latE6: number;
  lonE6: number;
  scenarioId: number;
  triggerDistanceM: number;
  bump: number;
}

/** `["market", homeowner, market_nonce]` (§5.3) */
export interface MarketAccount {
  homeowner: PublicKey;
  marketNonce: BN;
  propertyId: number;
  latE6: number;
  lonE6: number;
  scenarioId: number;
  triggerDistanceM: number;
  coverageTarget: BN;
  coverageActivated: BN;
  acceptedCount: number;
  status: MarketStatusRaw;
  evidenceHash: number[];
  createdAt: BN;
  closedAt: BN;
  resolvedAt: BN;
  bump: number;
}

/** `["offer", market, underwriter, offer_nonce]` (§5.4) */
export interface OfferAccount {
  market: PublicKey;
  underwriter: PublicKey;
  offerNonce: BN;
  coverage: BN;
  premiumBps: number;
  premium: BN;
  collateral: BN;
  /** `PublicKey.default` until accepted. */
  protectionHolder: PublicKey;
  /** `PublicKey.default` until accepted. */
  riskHolder: PublicKey;
  status: OfferStatusRaw;
  createdAt: BN;
  acceptedAt: BN;
  bump: number;
  vaultBump: number;
}

/** `["listing", offer, side]` (§5.6, Tier 2) */
export interface ListingAccount {
  offer: PublicKey;
  side: number;
  seller: PublicKey;
  price: BN;
  createdAt: BN;
  bump: number;
}

// ---------- Derived display states (§10.2) ----------

export type MarketDisplayState =
  | "Accepting offers"
  | "Funded"
  | "Closed — awaiting oracle"
  | "Resolved: triggered"
  | "Resolved: not triggered"
  | "Voided";

export function marketDisplayState(
  market: Pick<MarketAccount, "status" | "coverageActivated" | "coverageTarget">,
): MarketDisplayState {
  switch (marketStatusOf(market.status)) {
    case "open":
      return market.coverageActivated.gte(market.coverageTarget) ? "Funded" : "Accepting offers";
    case "closed":
      return "Closed — awaiting oracle";
    case "resolvedYes":
      return "Resolved: triggered";
    case "resolvedNo":
      return "Resolved: not triggered";
    case "voided":
      return "Voided";
  }
}
