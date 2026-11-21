// Typed readers for metrex_exchange accounts (spec-v2 §6). Amounts are bigint; keys are PublicKey.

import type { BN } from "@anchor-lang/core";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SYSVAR_CLOCK_PUBKEY, type Commitment, type Connection, type GetProgramAccountsFilter } from "@solana/web3.js";
import {
  findConfigPda,
  findPropertyPda,
  OrderSide,
  type MarketOutcomeName,
  type OrderAccount,
  type OrderSideCode,
  type OutcomeCode,
} from "@metrex/exchange";
import type { ExchangeProgram } from "./program";

const big = (v: BN | number): bigint => BigInt(v.toString());
const enumName = (v: object): string => Object.keys(v)[0] ?? "";

export interface ConfigView {
  address: PublicKey;
  admin: PublicKey;
  roundController: PublicKey;
  oracleAuthority: PublicKey;
  collateralMint: PublicKey;
  latestRound: PublicKey;
  nextRoundId: bigint;
  resolutionTimeoutS: bigint;
}

export interface RoundView {
  address: PublicKey;
  roundId: bigint;
  scenarioId: number;
  datasetSha256: Uint8Array;
  label: string;
  status: "open" | "closed";
  createdAt: bigint;
  tradingEndsAt: bigint;
  closedAt: bigint;
  marketCount: number;
  resolvedCount: number;
}

export interface MarketView {
  address: PublicKey;
  round: PublicKey;
  propertyId: number;
  scenarioId: number;
  latE6: number;
  lonE6: number;
  triggerDistanceM: number;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  outcome: MarketOutcomeName;
  evidenceHash: Uint8Array;
  pairsOutstanding: bigint;
  nextOrderSeq: bigint;
  createdAt: bigint;
  resolvedAt: bigint;
  resolutionPath: number;
  invalidReason: number;
}

export interface PropertyView {
  address: PublicKey;
  propertyId: number;
  label: string;
  latE6: number;
  lonE6: number;
  scenarioId: number;
  triggerDistanceM: number;
}

export const decodeLabel = (bytes: number[] | Uint8Array): string => {
  const b = Uint8Array.from(bytes);
  const end = b.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? b.subarray(0, end) : b);
};

/** Account discriminator (8) is followed by the first field. */
export const ROUND_OFFSET_IN_MARKET = 8;
export const MARKET_OFFSET_IN_ORDER = 8;
export const MAKER_OFFSET_IN_ORDER = 40;

export const exchangeConfigPda = (p: ExchangeProgram): PublicKey => findConfigPda(p.programId)[0];

export async function fetchExchangeConfig(p: ExchangeProgram, commitment?: Commitment): Promise<ConfigView | null> {
  const address = exchangeConfigPda(p);
  const c = await p.account.config.fetchNullable(address, commitment);
  if (!c) return null;
  return {
    address,
    admin: c.admin,
    roundController: c.roundController,
    oracleAuthority: c.oracleAuthority,
    collateralMint: c.collateralMint,
    latestRound: c.latestRound,
    nextRoundId: big(c.nextRoundId),
    resolutionTimeoutS: big(c.resolutionTimeoutS),
  };
}

type RawRound = Awaited<ReturnType<ExchangeProgram["account"]["round"]["fetch"]>>;
const toRound = (address: PublicKey, r: RawRound): RoundView => ({
  address,
  roundId: big(r.roundId),
  scenarioId: r.scenarioId,
  datasetSha256: Uint8Array.from(r.datasetSha256),
  label: decodeLabel(r.label),
  status: enumName(r.status) === "open" ? "open" : "closed",
  createdAt: big(r.createdAt),
  tradingEndsAt: big(r.tradingEndsAt),
  closedAt: big(r.closedAt),
  marketCount: r.marketCount,
  resolvedCount: r.resolvedCount,
});

export async function fetchRound(p: ExchangeProgram, address: PublicKey, commitment?: Commitment): Promise<RoundView | null> {
  const r = await p.account.round.fetchNullable(address, commitment);
  return r ? toRound(address, r) : null;
}

export async function fetchAllRounds(p: ExchangeProgram): Promise<RoundView[]> {
  const rows = await p.account.round.all();
  return rows.map((r) => toRound(r.publicKey, r.account)).sort((a, b) => (a.roundId < b.roundId ? -1 : 1));
}

type RawMarket = Awaited<ReturnType<ExchangeProgram["account"]["market"]["fetch"]>>;
const toMarket = (address: PublicKey, m: RawMarket): MarketView => ({
  address,
  round: m.round,
  propertyId: m.propertyId,
  scenarioId: m.scenarioId,
  latE6: m.latE6,
  lonE6: m.lonE6,
  triggerDistanceM: m.triggerDistanceM,
  yesMint: m.yesMint,
  noMint: m.noMint,
  vault: m.vault,
  outcome: enumName(m.outcome) as MarketOutcomeName,
  evidenceHash: Uint8Array.from(m.evidenceHash),
  pairsOutstanding: big(m.pairsOutstanding),
  nextOrderSeq: big(m.nextOrderSeq),
  createdAt: big(m.createdAt),
  resolvedAt: big(m.resolvedAt),
  resolutionPath: m.resolutionPath,
  invalidReason: m.invalidReason,
});

export async function fetchExchangeMarket(p: ExchangeProgram, address: PublicKey, commitment?: Commitment): Promise<MarketView | null> {
  const m = await p.account.market.fetchNullable(address, commitment);
  return m ? toMarket(address, m) : null;
}

export async function fetchMarketsOfRound(p: ExchangeProgram, round: PublicKey): Promise<MarketView[]> {
  const rows = await p.account.market.all([{ memcmp: { offset: ROUND_OFFSET_IN_MARKET, bytes: round.toBase58() } }]);
  return rows.map((r) => toMarket(r.publicKey, r.account)).sort((a, b) => a.propertyId - b.propertyId);
}

export async function fetchProperty(p: ExchangeProgram, propertyId: number): Promise<PropertyView | null> {
  const address = findPropertyPda(p.programId, propertyId)[0];
  const r = await p.account.property.fetchNullable(address);
  if (!r) return null;
  return {
    address,
    propertyId: r.propertyId,
    label: decodeLabel(r.label),
    latE6: r.latE6,
    lonE6: r.lonE6,
    scenarioId: r.scenarioId,
    triggerDistanceM: r.triggerDistanceM,
  };
}

type RawOrder = Awaited<ReturnType<ExchangeProgram["account"]["order"]["fetch"]>>;
export const toOrderAccount = (address: PublicKey, o: RawOrder): OrderAccount => ({
  address: address.toBase58(),
  market: o.market.toBase58(),
  maker: o.maker.toBase58(),
  clientNonce: big(o.clientNonce),
  outcome: o.outcome as OutcomeCode,
  side: o.side as OrderSideCode,
  priceBps: o.priceBps,
  originalQty: big(o.originalQty),
  remainingQty: big(o.remainingQty),
  seq: big(o.seq),
  expiresAt: big(o.expiresAt),
  createdAt: big(o.createdAt),
});

export async function fetchOrders(
  p: ExchangeProgram,
  by: { market?: PublicKey; maker?: PublicKey },
): Promise<OrderAccount[]> {
  const filters: GetProgramAccountsFilter[] = [];
  if (by.market) filters.push({ memcmp: { offset: MARKET_OFFSET_IN_ORDER, bytes: by.market.toBase58() } });
  if (by.maker) filters.push({ memcmp: { offset: MAKER_OFFSET_IN_ORDER, bytes: by.maker.toBase58() } });
  const rows = await p.account.order.all(filters);
  return rows.map((r) => toOrderAccount(r.publicKey, r.account));
}

/** Chain time from the Clock sysvar (unix seconds). */
export async function chainNow(conn: Connection, commitment: Commitment = "confirmed"): Promise<bigint> {
  const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY, commitment);
  if (!info) throw new Error("Clock sysvar unavailable");
  return info.data.readBigInt64LE(32);
}

export const ataOf = (mint: PublicKey, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);

/** The mint an order's maker receives on a fill: the outcome mint for BUY, mUSD for SELL. */
export function receiveMintOf(o: Pick<OrderAccount, "outcome" | "side">, m: Pick<MarketView, "yesMint" | "noMint">, collateral: PublicKey): PublicKey {
  if (o.side === OrderSide.Sell) return collateral;
  return o.outcome === 0 ? m.yesMint : m.noMint;
}

/** The mint held in an order's escrow: mUSD for BUY, the outcome mint for SELL. */
export function escrowMintOf(o: Pick<OrderAccount, "outcome" | "side">, m: Pick<MarketView, "yesMint" | "noMint">, collateral: PublicKey): PublicKey {
  if (o.side === OrderSide.Buy) return collateral;
  return o.outcome === 0 ? m.yesMint : m.noMint;
}

/** Existence of many accounts in batches of 100 (getMultipleAccounts limit). */
export async function accountsExist(conn: Connection, keys: readonly PublicKey[], commitment: Commitment = "confirmed"): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const infos = await conn.getMultipleAccountsInfo(keys.slice(i, i + 100) as PublicKey[], commitment);
    for (const info of infos) out.push(info !== null);
  }
  return out;
}

/** SPL token balance in base units; 0 if the account doesn't exist. */
export async function tokenBalance(conn: Connection, account: PublicKey, commitment: Commitment = "confirmed"): Promise<bigint> {
  const info = await conn.getAccountInfo(account, commitment);
  if (!info || info.data.length < 72) return 0n;
  return info.data.readBigUInt64LE(64);
}
