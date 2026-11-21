// Send + confirm with blockhash-expiry retry, and readable program errors (spec §10.1).

import {
  Transaction,
  TransactionExpiredBlockheightExceededError,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import { ERROR_MESSAGES, errorNameOf } from "@metrex/shared";

export interface SendOptions {
  /** Attempts on blockhash expiry (each re-checks the previous signature first). Default 3. */
  attempts?: number;
  commitment?: "confirmed" | "finalized";
}

export class TxError extends Error {
  constructor(
    message: string,
    readonly logs: readonly string[] = [],
    readonly signature?: string,
  ) {
    super(message);
    this.name = "TxError";
  }
}

/**
 * Builds a legacy transaction from `instructions`, signs with `signers` (first = fee payer),
 * sends and waits for `confirmed`. Returns the signature.
 */
export async function sendTx(
  conn: Connection,
  instructions: readonly TransactionInstruction[],
  signers: readonly Keypair[],
  opts: SendOptions = {},
): Promise<string> {
  const payer = signers[0];
  if (!payer) throw new Error("sendTx needs at least one signer (fee payer)");
  const attempts = opts.attempts ?? 3;
  const commitment = opts.commitment ?? "confirmed";
  let lastSig: string | undefined;
  for (let i = 0; i < attempts; i++) {
    if (lastSig) {
      // The previous attempt may have landed late; never double-send.
      const st = await conn.getSignatureStatus(lastSig, { searchTransactionHistory: true });
      const status = st.value?.confirmationStatus;
      if (st.value && !st.value.err && (status === "finalized" || status === commitment)) return lastSig;
      if (st.value && !st.value.err) {
        throw new TxError("Previous transaction is awaiting confirmation", [], lastSig);
      }
    }
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });
    tx.add(...instructions);
    tx.sign(...signers);
    let sig: string;
    try {
      sig = await conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    } catch (e) {
      throw toTxError(e);
    }
    lastSig = sig;
    try {
      const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, commitment);
      if (res.value.err) {
        const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        const logs = t?.meta?.logMessages ?? [];
        throw new TxError(describeLogs(logs) ?? `Transaction failed: ${JSON.stringify(res.value.err)}`, logs, sig);
      }
      return sig;
    } catch (e) {
      if (e instanceof TransactionExpiredBlockheightExceededError) continue;
      throw e instanceof TxError ? e : toTxError(e);
    }
  }
  throw new TxError(`Transaction not confirmed after ${attempts} attempts`, [], lastSig);
}

/** Maps Anchor custom error codes in logs/messages to the shared readable messages. */
export function describeLogs(logs: readonly string[]): string | undefined {
  for (const line of logs) {
    const d = describeErrorText(line);
    if (d) return d;
  }
  return undefined;
}

export function describeErrorText(text: string): string | undefined {
  const anchor = /Error Code: (\w+)\. Error Number: (\d+)/.exec(text);
  if (anchor) {
    const name = errorNameOf(Number(anchor[2]));
    if (name) return `${name}: ${ERROR_MESSAGES[name]}`;
    return `${anchor[1]} (${anchor[2]})`;
  }
  const custom = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (custom) {
    const code = parseInt(custom[1] as string, 16);
    const name = errorNameOf(code);
    if (name) return `${name}: ${ERROR_MESSAGES[name]}`;
    return `custom program error ${code}`;
  }
  return undefined;
}

export function toTxError(e: unknown): TxError {
  if (e instanceof TxError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const logs = (e as { logs?: unknown }).logs;
  const logArr = Array.isArray(logs) ? logs.filter((l): l is string => typeof l === "string") : [];
  return new TxError(describeLogs(logArr) ?? describeErrorText(msg) ?? msg.split("\n")[0] ?? msg, logArr);
}
