// PDA helpers for every seed in spec-v2 §6. FROZEN at Gate V0. Integers are little-endian.
// The program ID is always passed in; this package never hard-codes it.

import { PublicKey } from "@solana/web3.js";
import { SEEDS } from "./constants";

type U64Like = bigint | number | { toString(): string };
const enc = new TextEncoder();
const s = (name: keyof typeof SEEDS): Uint8Array => enc.encode(SEEDS[name]);

export function u16LE(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`u16 out of range: ${value}`);
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value, true);
  return out;
}

export function u64LE(value: U64Like): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(value.toString());
  if (v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new RangeError(`u64 out of range: ${v}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}

const find = (seeds: Uint8Array[], programId: PublicKey) => PublicKey.findProgramAddressSync(seeds, programId);

/** `["config"]` */
export const findConfigPda = (pid: PublicKey) => find([s("config")], pid);
/** `["property", property_id: u16]` */
export const findPropertyPda = (pid: PublicKey, propertyId: number) => find([s("property"), u16LE(propertyId)], pid);
/** `["round", round_id: u64]` */
export const findRoundPda = (pid: PublicKey, roundId: U64Like) => find([s("round"), u64LE(roundId)], pid);
/** `["market", round, property_id: u16]` */
export const findMarketPda = (pid: PublicKey, round: PublicKey, propertyId: number) =>
  find([s("market"), round.toBytes(), u16LE(propertyId)], pid);
/** `["yes_mint", market]` */
export const findYesMintPda = (pid: PublicKey, market: PublicKey) => find([s("yesMint"), market.toBytes()], pid);
/** `["no_mint", market]` */
export const findNoMintPda = (pid: PublicKey, market: PublicKey) => find([s("noMint"), market.toBytes()], pid);
/** `["vault", market]` */
export const findVaultPda = (pid: PublicKey, market: PublicKey) => find([s("vault"), market.toBytes()], pid);
/** `["order", market, maker, client_nonce: u64]` */
export const findOrderPda = (pid: PublicKey, market: PublicKey, maker: PublicKey, clientNonce: U64Like) =>
  find([s("order"), market.toBytes(), maker.toBytes(), u64LE(clientNonce)], pid);
/** `["escrow", order]` */
export const findEscrowPda = (pid: PublicKey, order: PublicKey) => find([s("escrow"), order.toBytes()], pid);

/** All PDAs of one market. */
export function marketAddresses(pid: PublicKey, round: PublicKey, propertyId: number) {
  const [market] = findMarketPda(pid, round, propertyId);
  return {
    market,
    yesMint: findYesMintPda(pid, market)[0],
    noMint: findNoMintPda(pid, market)[0],
    vault: findVaultPda(pid, market)[0],
  };
}

/** Random client nonce for order PDAs (never a shared counter, flaw #5). */
export function randomNonce(): bigint {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return new DataView(b.buffer).getBigUint64(0, true);
}
