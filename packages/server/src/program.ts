// Anchor Program factory from the committed IDL (target/idl/metrex.json, FROZEN).
// The IDL is read from disk at runtime (not bundled) so tsx scripts, the bot worker
// and Next.js route handlers all load the exact committed file.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AnchorProvider, Program } from "@anchor-lang/core";
import {
  Keypair,
  PublicKey,
  type Connection,
  type Transaction,
  type VersionedTransaction,
} from "@solana/web3.js";
import type { Metrex } from "../../../target/types/metrex";
import { envOrUndefined, repoRoot, resolveFromRoot } from "./env";

export type { Metrex };
export type MetrexProgram = Program<Metrex>;
/** The provider wallet interface (not the NodeWallet class `Wallet` exported by Anchor). */
export type ProviderWallet = ConstructorParameters<typeof AnchorProvider>[1];

let idlCache: Metrex | undefined;

export function loadIdl(): Metrex {
  if (!idlCache) {
    const path = envOrUndefined("METREX_IDL_PATH")
      ? resolveFromRoot(envOrUndefined("METREX_IDL_PATH") as string)
      : join(repoRoot(), "target", "idl", "metrex.json");
    idlCache = JSON.parse(readFileSync(path, "utf8")) as Metrex;
  }
  return idlCache;
}

/** Program ID: `PROGRAM_ID` env if set (must match the IDL), else the IDL address. */
export function programId(): PublicKey {
  const idl = loadIdl();
  const fromEnv = envOrUndefined("PROGRAM_ID");
  if (fromEnv && fromEnv !== idl.address) {
    throw new Error(`PROGRAM_ID ${fromEnv} does not match the committed IDL address ${idl.address}`);
  }
  return new PublicKey(idl.address);
}

/** Wallet adapter over a server keypair. */
export class KeypairWallet implements ProviderWallet {
  constructor(readonly payer: Keypair) {}
  get publicKey(): PublicKey {
    return this.payer.publicKey;
  }
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if ("version" in tx) tx.sign([this.payer]);
    else tx.partialSign(this.payer);
    return tx;
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    for (const tx of txs) await this.signTransaction(tx);
    return txs;
  }
}

/** For read-only programs: has a public key but refuses to sign. */
export class ReadonlyWallet implements ProviderWallet {
  readonly publicKey = Keypair.generate().publicKey;
  async signTransaction<T extends Transaction | VersionedTransaction>(): Promise<T> {
    throw new Error("read-only wallet cannot sign");
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(): Promise<T[]> {
    throw new Error("read-only wallet cannot sign");
  }
}

const programCache = new WeakMap<Connection, MetrexProgram>();

/**
 * A Program bound to `conn`. Instructions are built with `.instruction()` and sent via
 * `sendTx` (tx.ts) with explicit signers, so the provider wallet never signs.
 */
export function getProgram(conn: Connection): MetrexProgram {
  let p = programCache.get(conn);
  if (!p) {
    programId(); // validates PROGRAM_ID against the IDL
    const provider = new AnchorProvider(conn, new ReadonlyWallet(), { commitment: "confirmed" });
    p = new Program<Metrex>(loadIdl(), provider);
    programCache.set(conn, p);
  }
  return p;
}
