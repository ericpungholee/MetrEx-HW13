// Account reads: byte offsets for memcmp filters (derived from the frozen IDL; verified in
// accounts.test.ts), and bigint "views" of decoded accounts for pure logic.

import { utils } from "@anchor-lang/core";
import type { GetProgramAccountsFilter, PublicKey } from "@solana/web3.js";
import {
  findMarketPda,
  marketStatusOf,
  offerStatusOf,
  u16LE,
  type ListingAccount,
  type MarketAccount,
  type MarketStatus,
  type OfferAccount,
  type OfferStatus,
} from "@metrex/shared";
import type { MetrexProgram } from "./program";

/** Byte offsets including the 8-byte Anchor discriminator. */
export const OFFSETS = {
  market: { homeowner: 8, marketNonce: 40, propertyId: 48, status: 82 },
  offer: { market: 8, underwriter: 40, riskHolder: 138, status: 170 },
  listing: { offer: 8, side: 40, seller: 41 },
} as const;

export const MARKET_STATUS_INDEX: Record<MarketStatus, number> = {
  open: 0,
  closed: 1,
  resolvedYes: 2,
  resolvedNo: 3,
  voided: 4,
};

export const OFFER_STATUS_INDEX: Record<OfferStatus, number> = {
  open: 0,
  accepted: 1,
  cancelled: 2,
  claimed: 3,
  refunded: 4,
};

function memcmp(offset: number, bytes: Uint8Array): GetProgramAccountsFilter {
  return { memcmp: { offset, bytes: utils.bytes.bs58.encode(bytes) } };
}

export const filters = {
  marketStatus: (s: MarketStatus) => memcmp(OFFSETS.market.status, Uint8Array.of(MARKET_STATUS_INDEX[s])),
  marketHomeowner: (pk: PublicKey) => memcmp(OFFSETS.market.homeowner, pk.toBytes()),
  marketPropertyId: (id: number) => memcmp(OFFSETS.market.propertyId, u16LE(id)),
  offerMarket: (pk: PublicKey) => memcmp(OFFSETS.offer.market, pk.toBytes()),
  offerUnderwriter: (pk: PublicKey) => memcmp(OFFSETS.offer.underwriter, pk.toBytes()),
  offerRiskHolder: (pk: PublicKey) => memcmp(OFFSETS.offer.riskHolder, pk.toBytes()),
  offerStatus: (s: OfferStatus) => memcmp(OFFSETS.offer.status, Uint8Array.of(OFFER_STATUS_INDEX[s])),
  listingSeller: (pk: PublicKey) => memcmp(OFFSETS.listing.seller, pk.toBytes()),
};

// ---------- Views (bigint amounts, string statuses) ----------

export interface MarketView {
  pubkey: PublicKey;
  homeowner: PublicKey;
  marketNonce: bigint;
  propertyId: number;
  latE6: number;
  lonE6: number;
  scenarioId: number;
  triggerDistanceM: number;
  coverageTarget: bigint;
  coverageActivated: bigint;
  acceptedCount: number;
  status: MarketStatus;
  evidenceHash: Uint8Array;
  createdAt: bigint;
}

export interface OfferView {
  pubkey: PublicKey;
  market: PublicKey;
  underwriter: PublicKey;
  offerNonce: bigint;
  coverage: bigint;
  premiumBps: number;
  premium: bigint;
  collateral: bigint;
  protectionHolder: PublicKey;
  riskHolder: PublicKey;
  status: OfferStatus;
  createdAt: bigint;
}

export interface ListingView {
  pubkey: PublicKey;
  offer: PublicKey;
  side: number;
  seller: PublicKey;
  price: bigint;
}

const big = (v: { toString(): string }): bigint => BigInt(v.toString());

export function toMarketView(pubkey: PublicKey, a: MarketAccount): MarketView {
  return {
    pubkey,
    homeowner: a.homeowner,
    marketNonce: big(a.marketNonce),
    propertyId: a.propertyId,
    latE6: a.latE6,
    lonE6: a.lonE6,
    scenarioId: a.scenarioId,
    triggerDistanceM: a.triggerDistanceM,
    coverageTarget: big(a.coverageTarget),
    coverageActivated: big(a.coverageActivated),
    acceptedCount: a.acceptedCount,
    status: marketStatusOf(a.status),
    evidenceHash: Uint8Array.from(a.evidenceHash),
    createdAt: big(a.createdAt),
  };
}

export function toOfferView(pubkey: PublicKey, a: OfferAccount): OfferView {
  return {
    pubkey,
    market: a.market,
    underwriter: a.underwriter,
    offerNonce: big(a.offerNonce),
    coverage: big(a.coverage),
    premiumBps: a.premiumBps,
    premium: big(a.premium),
    collateral: big(a.collateral),
    protectionHolder: a.protectionHolder,
    riskHolder: a.riskHolder,
    status: offerStatusOf(a.status),
    createdAt: big(a.createdAt),
  };
}

export function toListingView(pubkey: PublicKey, a: ListingAccount): ListingView {
  return { pubkey, offer: a.offer, side: a.side, seller: a.seller, price: big(a.price) };
}

// ---------- Fetchers ----------

export async function fetchMarket(
  program: MetrexProgram, pk: PublicKey, commitment?: "confirmed" | "finalized",
): Promise<MarketView | null> {
  const info = await program.provider.connection.getAccountInfo(pk, commitment);
  if (!info?.owner.equals(program.programId)) return null;
  const account = program.coder.accounts.decode<MarketAccount>("market", info.data);
  const [expected] = findMarketPda(program.programId, account.homeowner, big(account.marketNonce));
  return expected.equals(pk) ? toMarketView(pk, account) : null;
}

export async function fetchMarkets(
  program: MetrexProgram,
  f: GetProgramAccountsFilter[] = [],
): Promise<MarketView[]> {
  const rows = await program.account.market.all(f);
  return rows.map((r) => toMarketView(r.publicKey, r.account as MarketAccount));
}

export async function fetchMarketsByKey(
  program: MetrexProgram,
  keys: readonly PublicKey[],
): Promise<Map<string, MarketView>> {
  const out = new Map<string, MarketView>();
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const rows = await program.account.market.fetchMultiple(chunk);
    rows.forEach((a, j) => {
      const k = chunk[j];
      if (a && k) out.set(k.toBase58(), toMarketView(k, a as MarketAccount));
    });
  }
  return out;
}

export async function fetchOffers(program: MetrexProgram, f: GetProgramAccountsFilter[]): Promise<OfferView[]> {
  const rows = await program.account.offer.all(f);
  return rows.map((r) => toOfferView(r.publicKey, r.account as OfferAccount));
}

export async function fetchListings(
  program: MetrexProgram,
  f: GetProgramAccountsFilter[],
): Promise<ListingView[]> {
  const rows = await program.account.listing.all(f);
  return rows.map((r) => toListingView(r.publicKey, r.account as ListingAccount));
}

export function isUnresolved(s: MarketStatus): boolean {
  return s === "open" || s === "closed";
}
