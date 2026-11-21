// Anchor Program for metrex_exchange (spec-v2) from the committed IDL (target/idl/metrex_exchange.json,
// frozen at V0). Like the v1 factory, the IDL is read from disk at runtime.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AnchorProvider, Program } from "@anchor-lang/core";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { MetrexExchange } from "../../../../target/types/metrex_exchange";
import { envOrUndefined, repoRoot, resolveFromRoot } from "../env";
import { ReadonlyWallet } from "../program";

export type { MetrexExchange };
export type ExchangeProgram = Program<MetrexExchange>;

let idlCache: MetrexExchange | undefined;

export function loadExchangeIdl(): MetrexExchange {
  if (!idlCache) {
    const path = envOrUndefined("EXCHANGE_IDL_PATH")
      ? resolveFromRoot(envOrUndefined("EXCHANGE_IDL_PATH") as string)
      : join(repoRoot(), "target", "idl", "metrex_exchange.json");
    idlCache = JSON.parse(readFileSync(path, "utf8")) as MetrexExchange;
  }
  return idlCache;
}

/** v2 program ID: `EXCHANGE_PROGRAM_ID` env if set (must match the IDL), else the IDL address. */
export function exchangeProgramId(): PublicKey {
  const idl = loadExchangeIdl();
  const fromEnv = envOrUndefined("EXCHANGE_PROGRAM_ID");
  if (fromEnv && fromEnv !== idl.address) {
    throw new Error(`EXCHANGE_PROGRAM_ID ${fromEnv} does not match the committed IDL address ${idl.address}`);
  }
  return new PublicKey(idl.address);
}

const cache = new WeakMap<Connection, ExchangeProgram>();

/** A read-only-wallet Program bound to `conn`. Build instructions with `.instruction()`, send with `sendExchangeTx`. */
export function getExchangeProgram(conn: Connection): ExchangeProgram {
  let p = cache.get(conn);
  if (!p) {
    exchangeProgramId();
    const provider = new AnchorProvider(conn, new ReadonlyWallet(), { commitment: "confirmed" });
    p = new Program<MetrexExchange>(loadExchangeIdl(), provider);
    cache.set(conn, p);
  }
  return p;
}
