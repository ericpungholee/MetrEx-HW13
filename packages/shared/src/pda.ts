// PDA helpers for every seed in spec §5. FROZEN after Gate 0.
// Integers in seeds are little-endian. The program ID is always passed in
// (from the IDL or env), so this package never hard-codes it.

import { PublicKey } from "@solana/web3.js";
import { SEEDS, type Side } from "./constants";

type U64Like = bigint | number | { toString(): string };

const encoder = new TextEncoder();

function seed(name: keyof typeof SEEDS): Uint8Array {
  return encoder.encode(SEEDS[name]);
}

export function u16LE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`u16 out of range: ${value}`);
  }
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

export function u64LE(value: U64Like): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(value.toString());
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) {
    throw new RangeError(`u64 out of range: ${v}`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

export function u8(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`u8 out of range: ${value}`);
  }
  return Uint8Array.of(value);
}

/** `["config"]` */
export function findConfigPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([seed("config")], programId);
}

/** `["property", property_id: u16]` */
export function findPropertyPda(programId: PublicKey, propertyId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([seed("property"), u16LE(propertyId)], programId);
}

/** `["market", homeowner, market_nonce: u64]` */
export function findMarketPda(
  programId: PublicKey,
  homeowner: PublicKey,
  marketNonce: U64Like,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seed("market"), homeowner.toBytes(), u64LE(marketNonce)],
    programId,
  );
}

/** `["offer", market, underwriter, offer_nonce: u64]` */
export function findOfferPda(
  programId: PublicKey,
  market: PublicKey,
  underwriter: PublicKey,
  offerNonce: U64Like,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [seed("offer"), market.toBytes(), underwriter.toBytes(), u64LE(offerNonce)],
    programId,
  );
}

/** `["vault", offer]` */
export function findVaultPda(programId: PublicKey, offer: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([seed("vault"), offer.toBytes()], programId);
}

/** `["listing", offer, side: u8]` (Tier 2) */
export function findListingPda(
  programId: PublicKey,
  offer: PublicKey,
  side: Side,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([seed("listing"), offer.toBytes(), u8(side)], programId);
}

/** Random u64 nonce for offers and markets (spec §5.3, §5.4). */
export function randomNonce(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer).getBigUint64(0, true);
}
