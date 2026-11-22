// mUSD mint + ATA helpers and balance checks. Amounts are bigint base units.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { MUSD_DECIMALS, MUSD_UNIT } from "@metrex/shared";
import { envOrUndefined, keyDir } from "./env";

/** Public info, not a secret: `{ "mint": "<base58>" }` written by setup-devnet. */
export function musdMintFile(): string {
  return join(keyDir(), "musd-mint.json");
}

export function readMintFile(path: string = musdMintFile()): PublicKey | undefined {
  if (!existsSync(/* turbopackIgnore: true */ path)) return undefined;
  const parsed = JSON.parse(readFileSync(/* turbopackIgnore: true */ path, "utf8")) as { mint?: unknown };
  if (typeof parsed.mint !== "string") throw new Error(`${path} has no "mint" field`);
  return new PublicKey(parsed.mint);
}

/** mUSD mint: `MUSD_MINT` env, else `~/.config/metrex/musd-mint.json`. */
export function musdMint(): PublicKey {
  const fromEnv = envOrUndefined("MUSD_MINT");
  if (fromEnv) return new PublicKey(fromEnv);
  const fromFile = readMintFile();
  if (fromFile) return fromFile;
  throw new Error("mUSD mint unknown: set MUSD_MINT or run scripts/setup-devnet-v2.ts");
}

/** Classic SPL Token ATA (the program uses `Tokenkeg…` only). */
export function musdAta(owner: PublicKey, mint: PublicKey = musdMint()): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);
}

export function createAtaIdempotentIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey = musdMint(),
): TransactionInstruction {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    musdAta(owner, mint),
    owner,
    mint,
    TOKEN_PROGRAM_ID,
  );
}

export async function getSolLamports(conn: Connection, owner: PublicKey): Promise<bigint> {
  return BigInt(await conn.getBalance(owner, "confirmed"));
}

/** mUSD base units in the owner's ATA; 0 if the ATA doesn't exist. */
export async function getMusdBalance(
  conn: Connection,
  owner: PublicKey,
  mint: PublicKey = musdMint(),
): Promise<bigint> {
  const ata = musdAta(owner, mint);
  const info = await conn.getAccountInfo(ata, "confirmed");
  if (!info) return 0n;
  const bal = await conn.getTokenAccountBalance(ata, "confirmed");
  return BigInt(bal.value.amount);
}

export const LAMPORTS = BigInt(LAMPORTS_PER_SOL);

/** Formats bigint base units with `decimals` places, trimming trailing zeros. No floats. */
export function formatUnits(amount: bigint, decimals: number): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}

export function formatSol(lamports: bigint): string {
  return formatUnits(lamports, 9);
}

export function formatMusd(baseUnits: bigint): string {
  return formatUnits(baseUnits, MUSD_DECIMALS);
}

/** Whole mUSD → base units. */
export function musd(whole: bigint | number): bigint {
  return BigInt(whole) * MUSD_UNIT;
}

/** Decimal SOL string (e.g. "0.05") → lamports, exact. */
export function solToLamports(sol: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(sol);
  if (!m) throw new Error(`Invalid SOL amount ${sol}`);
  const whole = BigInt(m[1] as string);
  const frac = BigInt((m[2] ?? "").padEnd(9, "0") || "0");
  return whole * LAMPORTS + frac;
}
