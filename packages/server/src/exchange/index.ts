// "@metrex/server/exchange": the v2 chain client. Safe for the bot worker and the keeper:
// it never imports the oracle, @metrex/geo or settlement data (spec-v2 §8.4). The root
// "@metrex/server" entry re-exports oracle modules, so trading processes import this entry only.

import type { Connection, Keypair, TransactionInstruction } from "@solana/web3.js";
import { describeExchangeError } from "@metrex/exchange";
import { sendTx, type SendOptions } from "../tx";

export * from "./accounts";
export * from "./book";
export * from "./events";
export * from "./heartbeat";
export * from "./ix";
export * from "./keeper";
export * from "./program";
export * from "./trades";

export { envOrUndefined, expandHome, keyDir, loadKeypair, loadKeypairFile, parsePublicKey, repoRoot, type KeypairName } from "../env";
export { explorerAddress, explorerTx } from "../explorer";
export { getRpc, redactUrl, RpcPool } from "../rpc";
export { createAtaIdempotentIx, formatMusd, formatSol, getSolLamports, musd, musdMint, solToLamports } from "../token";
export { TxError } from "../tx";

/** `sendTx` with v2 error descriptions. */
export function sendExchangeTx(
  conn: Connection,
  ixs: readonly TransactionInstruction[],
  signers: readonly Keypair[],
  opts: SendOptions = {},
): Promise<string> {
  return sendTx(conn, ixs, signers, { describe: describeExchangeError, ...opts });
}

export { lockWorker } from "./worker-lock";
export { isClosureHeld } from "./closure-hold";
