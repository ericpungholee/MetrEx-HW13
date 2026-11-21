import type { Connection, PublicKey, SendOptions, Transaction } from "@solana/web3.js";

export class FixtureModeError extends Error {
  constructor() {
    super("Transactions are disabled in fixture mode.");
    this.name = "FixtureModeError";
  }
}

export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/user rejected|user declined|cancelled by (the )?user/i.test(message)) return "Signature declined in your wallet.";
  return message;
}

/** Browser wallets can submit with the connection so Wallet Standard receives the chain. */
export interface WalletSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction>(tx: T): Promise<T>;
  sendTransaction?(tx: Transaction, connection: Connection, options?: SendOptions): Promise<string>;
}

export interface TxResult {
  signature: string;
  slot: number;
  explorerUrl: string;
  latencyMs: number;
}

export type TxProgress =
  | { stage: "building" }
  | { stage: "signing"; total: number }
  | { stage: "sending"; index: number; total: number }
  | { stage: "confirmed"; index: number; total: number; result: TxResult };

export interface WriteOptions {
  onProgress?: (p: TxProgress) => void;
}

/** Raised after some transactions of a batch confirmed and a later one failed. */
export class PartialBatchError extends Error {
  constructor(
    public readonly confirmed: TxResult[],
    public override readonly cause: unknown,
  ) {
    super(`${confirmed.length} transaction(s) confirmed, then: ${describeError(cause)}`);
    this.name = "PartialBatchError";
  }
}
