// Batched transactions (spec §10.3): pack instruction groups into the fewest legacy
// transactions that fit Solana's 1232-byte packet limit. Pure; no network access.
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";

/** Solana's maximum serialized transaction size (PACKET_DATA_SIZE). */
export const MAX_TX_BYTES = 1232;

function shortVecLength(n: number): number {
  let len = 1;
  let rest = n >> 7;
  while (rest > 0) {
    len += 1;
    rest >>= 7;
  }
  return len;
}

/**
 * Serialized size in bytes of a transaction with these instructions, including one
 * 64-byte signature slot per required signer. Returns Infinity when it cannot be
 * compiled (e.g. it overflows web3.js's packet-sized buffer).
 */
export function measureTransactionSize(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
  recentBlockhash: string,
): number {
  try {
    const tx = new Transaction({ feePayer, recentBlockhash });
    tx.add(...instructions);
    const message = tx.compileMessage();
    const messageBytes = message.serialize().length;
    const sigs = message.header.numRequiredSignatures;
    return shortVecLength(sigs) + 64 * sigs + messageBytes;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface PackOptions {
  feePayer: PublicKey;
  recentBlockhash: string;
  /** Instructions placed at the start of every transaction (e.g. idempotent ATA creation). */
  prefix?: TransactionInstruction[];
  maxBytes?: number;
}

/**
 * Pack groups (each group must stay in one transaction, e.g. one `accept_offer`) into
 * the fewest transactions, preserving order. Groups are equal-shaped in practice, so
 * in-order greedy packing is optimal. Throws if a single group cannot fit on its own.
 */
export function packInstructionGroups(
  groups: TransactionInstruction[][],
  opts: PackOptions,
): TransactionInstruction[][] {
  const max = opts.maxBytes ?? MAX_TX_BYTES;
  const prefix = opts.prefix ?? [];
  const batches: TransactionInstruction[][] = [];
  let current: TransactionInstruction[] = [];

  for (const group of groups) {
    const candidate = [...current, ...group];
    if (measureTransactionSize([...prefix, ...candidate], opts.feePayer, opts.recentBlockhash) <= max) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new Error("A single instruction group is too large for one transaction");
    }
    batches.push(current);
    current = [...group];
    if (measureTransactionSize([...prefix, ...current], opts.feePayer, opts.recentBlockhash) > max) {
      throw new Error("A single instruction group is too large for one transaction");
    }
  }
  if (current.length > 0) batches.push(current);
  return batches.map((b) => [...prefix, ...b]);
}

/** Build unsigned transactions from packed batches. */
export function buildTransactions(
  batches: TransactionInstruction[][],
  feePayer: PublicKey,
  recentBlockhash: string,
): Transaction[] {
  return batches.map((ixs) => {
    const tx = new Transaction({ feePayer, recentBlockhash });
    tx.add(...ixs);
    return tx;
  });
}
