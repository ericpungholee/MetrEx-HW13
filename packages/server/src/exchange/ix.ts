// Instruction builders for metrex_exchange (spec-v2 §6.6). Each returns one TransactionInstruction;
// accounts are derived exactly as the frozen contexts expect (canonical ATAs, PDAs from @metrex/exchange).

import { BN } from "@anchor-lang/core";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  findEscrowPda,
  findOrderPda,
  findPropertyPda,
  findRoundPda,
  marketAddresses,
  type OrderAccount,
  type OrderSideCode,
  type OutcomeCode,
} from "@metrex/exchange";
import { ataOf, escrowMintOf, exchangeConfigPda, receiveMintOf, type MarketView } from "./accounts";
import type { ExchangeProgram } from "./program";

const bn = (v: bigint | number): BN => new BN(v.toString());
const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export const programDataOf = (pid: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([pid.toBuffer()], BPF_UPGRADEABLE_LOADER)[0];

type MarketKeys = Pick<MarketView, "address" | "round" | "yesMint" | "noMint" | "vault">;

export function initializeExchangeConfigIx(
  p: ExchangeProgram,
  a: { admin: PublicKey; roundController: PublicKey; oracleAuthority: PublicKey; collateralMint: PublicKey; resolutionTimeoutS: number },
): Promise<TransactionInstruction> {
  return p.methods
    .initializeConfig(a.roundController, a.oracleAuthority, bn(a.resolutionTimeoutS))
    .accountsPartial({
      admin: a.admin,
      config: exchangeConfigPda(p),
      collateralMint: a.collateralMint,
      program: p.programId,
      programData: programDataOf(p.programId),
    })
    .instruction();
}

export function registerExchangePropertyIx(
  p: ExchangeProgram,
  admin: PublicKey,
  r: { propertyId: number; label: number[]; latE6: number; lonE6: number; scenarioId: number; triggerDistanceM: number },
): Promise<TransactionInstruction> {
  return p.methods
    .registerProperty(r.propertyId, r.label, r.latE6, r.lonE6, r.scenarioId, r.triggerDistanceM)
    .accountsPartial({ admin, config: exchangeConfigPda(p), property: findPropertyPda(p.programId, r.propertyId)[0] })
    .instruction();
}

export function createRoundIx(
  p: ExchangeProgram,
  a: {
    roundController: PublicKey;
    roundId: bigint;
    previousRound: PublicKey | null;
    scenarioId: number;
    datasetSha256: number[];
    label: number[];
    tradingEndsAt: bigint;
  },
): Promise<TransactionInstruction> {
  return p.methods
    .createRound(a.scenarioId, a.datasetSha256, a.label, bn(a.tradingEndsAt))
    .accountsPartial({
      roundController: a.roundController,
      config: exchangeConfigPda(p),
      round: findRoundPda(p.programId, a.roundId)[0],
      previousRound: a.previousRound,
    })
    .instruction();
}

export function createMarketIx(
  p: ExchangeProgram,
  a: { roundController: PublicKey; round: PublicKey; propertyId: number; collateralMint: PublicKey },
): Promise<TransactionInstruction> {
  const m = marketAddresses(p.programId, a.round, a.propertyId);
  return p.methods
    .createMarket()
    .accountsPartial({
      roundController: a.roundController,
      config: exchangeConfigPda(p),
      round: a.round,
      property: findPropertyPda(p.programId, a.propertyId)[0],
      market: m.market,
      yesMint: m.yesMint,
      noMint: m.noMint,
      collateralMint: a.collateralMint,
      vault: m.vault,
    })
    .instruction();
}

export function splitIx(p: ExchangeProgram, m: MarketKeys, holder: PublicKey, collateral: PublicKey, q: bigint) {
  return p.methods
    .split(bn(q))
    .accountsPartial({
      holder,
      config: exchangeConfigPda(p),
      round: m.round,
      market: m.address,
      yesMint: m.yesMint,
      noMint: m.noMint,
      vault: m.vault,
      collateralMint: collateral,
      holderCollateral: ataOf(collateral, holder),
      holderYes: ataOf(m.yesMint, holder),
      holderNo: ataOf(m.noMint, holder),
    })
    .instruction();
}

export function mergeIx(p: ExchangeProgram, m: MarketKeys, holder: PublicKey, collateral: PublicKey, q: bigint) {
  return p.methods
    .merge(bn(q))
    .accountsPartial({
      holder,
      config: exchangeConfigPda(p),
      round: m.round,
      market: m.address,
      yesMint: m.yesMint,
      noMint: m.noMint,
      vault: m.vault,
      collateralMint: collateral,
      holderCollateral: ataOf(collateral, holder),
      holderYes: ataOf(m.yesMint, holder),
      holderNo: ataOf(m.noMint, holder),
    })
    .instruction();
}

export function redeemIx(p: ExchangeProgram, m: MarketKeys, holder: PublicKey, collateral: PublicKey, outcome: OutcomeCode, q: bigint) {
  const outcomeMint = outcome === 0 ? m.yesMint : m.noMint;
  return p.methods
    .redeem(outcome, bn(q))
    .accountsPartial({
      holder,
      config: exchangeConfigPda(p),
      market: m.address,
      outcomeMint,
      vault: m.vault,
      holderShares: ataOf(outcomeMint, holder),
      holderCollateral: ataOf(collateral, holder),
    })
    .instruction();
}

export interface PlaceParams {
  clientNonce: bigint;
  outcome: OutcomeCode;
  side: OrderSideCode;
  priceBps: number;
  quantity: bigint;
  expiresAt?: bigint;
}

export async function placeOrderIx(p: ExchangeProgram, m: MarketKeys, maker: PublicKey, collateral: PublicKey, o: PlaceParams) {
  const [order] = findOrderPda(p.programId, m.address, maker, o.clientNonce);
  const [escrow] = findEscrowPda(p.programId, order);
  const escrowMint = escrowMintOf(o, m, collateral);
  const receiveMint = receiveMintOf(o, m, collateral);
  const ix = await p.methods
    .placeOrder(bn(o.clientNonce), o.outcome, o.side, o.priceBps, bn(o.quantity), bn(o.expiresAt ?? 0n))
    .accountsPartial({
      maker,
      config: exchangeConfigPda(p),
      round: m.round,
      market: m.address,
      order,
      escrowMint,
      escrow,
      makerSource: ataOf(escrowMint, maker),
      receiveMint,
      makerReceive: ataOf(receiveMint, maker),
    })
    .instruction();
  return { ix, order, escrow };
}

/** Direct take of one resting order (§5.7). `limitPriceBps` is the taker's worst acceptable price. */
export async function takeOrderIx(
  p: ExchangeProgram,
  m: MarketKeys,
  taker: PublicKey,
  collateral: PublicKey,
  o: Pick<OrderAccount, "address" | "maker" | "outcome" | "side" | "seq">,
  quantity: bigint,
  limitPriceBps: number,
) {
  const order = new PublicKey(o.address);
  const escrowMint = escrowMintOf(o, m, collateral);
  const receiveMint = receiveMintOf(o, m, collateral);
  return p.methods
    .takeOrder(bn(quantity), limitPriceBps, bn(o.seq))
    .accountsPartial({
      taker,
      config: exchangeConfigPda(p),
      round: m.round,
      market: m.address,
      order,
      escrow: findEscrowPda(p.programId, order)[0],
      escrowMint,
      receiveMint,
      makerReceive: ataOf(receiveMint, new PublicKey(o.maker)),
      takerSource: ataOf(receiveMint, taker),
      takerReceive: ataOf(escrowMint, taker),
    })
    .instruction();
}

/**
 * `match_orders` (§5.5). Also returns the idempotent create of the buyer's canonical mUSD ATA,
 * which the frozen context requires even when the refund is zero (spec-v2 §0.2).
 */
export async function matchOrdersIx(
  p: ExchangeProgram,
  m: MarketKeys,
  caller: PublicKey,
  collateral: PublicKey,
  buy: Pick<OrderAccount, "address" | "maker" | "outcome">,
  sell: Pick<OrderAccount, "address" | "maker">,
  quantity: bigint,
): Promise<TransactionInstruction[]> {
  const outcomeMint = buy.outcome === 0 ? m.yesMint : m.noMint;
  const buyOrder = new PublicKey(buy.address);
  const sellOrder = new PublicKey(sell.address);
  const buyer = new PublicKey(buy.maker);
  const ix = await p.methods
    .matchOrders(bn(quantity))
    .accountsPartial({
      caller,
      config: exchangeConfigPda(p),
      round: m.round,
      market: m.address,
      outcomeMint,
      collateralMint: collateral,
      buyOrder,
      buyEscrow: findEscrowPda(p.programId, buyOrder)[0],
      sellOrder,
      sellEscrow: findEscrowPda(p.programId, sellOrder)[0],
      buyerShares: ataOf(outcomeMint, buyer),
      buyerCollateral: ataOf(collateral, buyer),
      sellerCollateral: ataOf(collateral, new PublicKey(sell.maker)),
    })
    .instruction();
  return [
    createAssociatedTokenAccountIdempotentInstruction(caller, ataOf(collateral, buyer), buyer, collateral, TOKEN_PROGRAM_ID),
    ix,
  ];
}

export function cancelOrderIx(
  p: ExchangeProgram,
  m: Pick<MarketView, "address" | "yesMint" | "noMint">,
  maker: PublicKey,
  collateral: PublicKey,
  o: Pick<OrderAccount, "address" | "outcome" | "side">,
) {
  const order = new PublicKey(o.address);
  const escrowMint = escrowMintOf(o, m, collateral);
  return p.methods
    .cancelOrder()
    .accountsPartial({
      maker,
      config: exchangeConfigPda(p),
      market: m.address,
      order,
      escrow: findEscrowPda(p.programId, order)[0],
      escrowMint,
      makerRefund: ataOf(escrowMint, maker),
    })
    .instruction();
}

export function sweepOrderIx(
  p: ExchangeProgram,
  m: MarketKeys,
  caller: PublicKey,
  collateral: PublicKey,
  o: Pick<OrderAccount, "address" | "maker" | "outcome" | "side">,
) {
  const order = new PublicKey(o.address);
  const maker = new PublicKey(o.maker);
  const escrowMint = escrowMintOf(o, m, collateral);
  return p.methods
    .sweepOrder()
    .accountsPartial({
      caller,
      maker,
      config: exchangeConfigPda(p),
      round: m.round,
      market: m.address,
      order,
      escrow: findEscrowPda(p.programId, order)[0],
      escrowMint,
      makerRefund: ataOf(escrowMint, maker),
    })
    .instruction();
}

export function closeRoundIx(p: ExchangeProgram, caller: PublicKey, round: PublicKey) {
  return p.methods.closeRound().accountsPartial({ caller, config: exchangeConfigPda(p), round }).instruction();
}

export function resolveExchangeMarketIx(
  p: ExchangeProgram,
  a: { oracleAuthority: PublicKey; round: PublicKey; market: PublicKey; triggered: boolean; evidenceHash: Uint8Array },
) {
  return p.methods
    .resolveMarket(a.triggered, Array.from(a.evidenceHash))
    .accountsPartial({ oracleAuthority: a.oracleAuthority, config: exchangeConfigPda(p), round: a.round, market: a.market })
    .instruction();
}

export function expireMarketIx(p: ExchangeProgram, caller: PublicKey, round: PublicKey, market: PublicKey) {
  return p.methods.expireMarket().accountsPartial({ caller, config: exchangeConfigPda(p), round, market }).instruction();
}

