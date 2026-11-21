// Instruction builders against the frozen IDL (spec §6). Every account is passed explicitly
// (accountsPartial) so nothing depends on client-side resolution. Authorities (oracle,
// controller, admin, mint) are always the caller's configured keys; the program checks
// them against Config.

import { BN } from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  findConfigPda,
  findListingPda,
  findMarketPda,
  findOfferPda,
  findPropertyPda,
  findVaultPda,
  type Side,
} from "@metrex/shared";
import type { MetrexProgram } from "./program";
import { musdAta } from "./token";

export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

export function programDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([programId.toBytes()], BPF_LOADER_UPGRADEABLE)[0];
}

const bn = (v: bigint): BN => new BN(v.toString());

export function configPda(program: MetrexProgram): PublicKey {
  return findConfigPda(program.programId)[0];
}

export function initializeConfigIx(
  program: MetrexProgram,
  a: { admin: PublicKey; oracle: PublicKey; controller: PublicKey; mint: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .initializeConfig(a.oracle, a.controller)
    .accountsPartial({
      admin: a.admin,
      config: configPda(program),
      mint: a.mint,
      program: program.programId,
      programData: programDataAddress(program.programId),
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export interface PropertyArgs {
  propertyId: number;
  label: number[];
  latE6: number;
  lonE6: number;
  scenarioId: number;
  triggerDistanceM: number;
}

export function registerPropertyIx(
  program: MetrexProgram,
  admin: PublicKey,
  p: PropertyArgs,
): Promise<TransactionInstruction> {
  return program.methods
    .registerProperty(p.propertyId, p.label, p.latE6, p.lonE6, p.scenarioId, p.triggerDistanceM)
    .accountsPartial({
      admin,
      config: configPda(program),
      property: findPropertyPda(program.programId, p.propertyId)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export function createMarketIx(
  program: MetrexProgram,
  a: { homeowner: PublicKey; marketNonce: bigint; propertyId: number; coverageTarget: bigint },
): Promise<TransactionInstruction> {
  return program.methods
    .createMarket(bn(a.marketNonce), a.propertyId, bn(a.coverageTarget))
    .accountsPartial({
      homeowner: a.homeowner,
      property: findPropertyPda(program.programId, a.propertyId)[0],
      market: findMarketPda(program.programId, a.homeowner, a.marketNonce)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export function placeOfferIx(
  program: MetrexProgram,
  a: {
    underwriter: PublicKey;
    market: PublicKey;
    offerNonce: bigint;
    coverage: bigint;
    premiumBps: number;
    mint: PublicKey;
  },
): Promise<TransactionInstruction> {
  const offer = findOfferPda(program.programId, a.market, a.underwriter, a.offerNonce)[0];
  return program.methods
    .placeOffer(bn(a.offerNonce), bn(a.coverage), a.premiumBps)
    .accountsPartial({
      underwriter: a.underwriter,
      config: configPda(program),
      market: a.market,
      offer,
      mint: a.mint,
      vault: findVaultPda(program.programId, offer)[0],
      underwriterToken: musdAta(a.underwriter, a.mint),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

export function cancelOfferIx(
  program: MetrexProgram,
  a: { underwriter: PublicKey; offer: PublicKey; mint: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .cancelOffer()
    .accountsPartial({
      underwriter: a.underwriter,
      config: configPda(program),
      offer: a.offer,
      vault: findVaultPda(program.programId, a.offer)[0],
      underwriterToken: musdAta(a.underwriter, a.mint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export function acceptOfferIx(
  program: MetrexProgram,
  a: { homeowner: PublicKey; market: PublicKey; offer: PublicKey; mint: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .acceptOffer()
    .accountsPartial({
      homeowner: a.homeowner,
      config: configPda(program),
      market: a.market,
      offer: a.offer,
      vault: findVaultPda(program.programId, a.offer)[0],
      homeownerToken: musdAta(a.homeowner, a.mint),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
}

export function closeMarketIx(
  program: MetrexProgram,
  a: { demoController: PublicKey; market: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods
    .closeMarket()
    .accountsPartial({ demoController: a.demoController, config: configPda(program), market: a.market })
    .instruction();
}

export async function resolveMarketIx(
  program: MetrexProgram,
  a: { oracleAuthority: PublicKey; market: PublicKey; triggered: boolean; evidenceHash: Uint8Array },
): Promise<TransactionInstruction> {
  if (a.evidenceHash.length !== 32) throw new Error("evidence hash must be 32 bytes");
  return program.methods
    .resolveMarket(a.triggered, Array.from(a.evidenceHash))
    .accountsPartial({ oracleAuthority: a.oracleAuthority, config: configPda(program), market: a.market })
    .instruction();
}

/** Tier 2 (§5.6). */
export function cancelListingIx(
  program: MetrexProgram,
  a: { seller: PublicKey; listing: PublicKey },
): Promise<TransactionInstruction> {
  return program.methods.cancelListing().accountsPartial({ seller: a.seller, listing: a.listing }).instruction();
}

/** Tier 2 (§5.6). */
export function listPositionIx(
  program: MetrexProgram,
  a: { seller: PublicKey; market: PublicKey; offer: PublicKey; side: Side; price: bigint },
): Promise<TransactionInstruction> {
  return program.methods
    .listPosition(a.side, bn(a.price))
    .accountsPartial({
      seller: a.seller,
      market: a.market,
      offer: a.offer,
      listing: findListingPda(program.programId, a.offer, a.side)[0],
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}
