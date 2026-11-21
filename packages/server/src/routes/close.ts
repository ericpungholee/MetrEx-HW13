// POST /api/demo/close/:market (spec §9.2 controller). Signs close_market with the
// demo_controller key; refuses anything that isn't Open.

import type { Keypair, PublicKey } from "@solana/web3.js";
import { fetchMarket } from "../accounts";
import { loadKeypair } from "../env";
import { explorerTx } from "../explorer";
import { closeMarketIx, configPda } from "../ix";
import { getProgram } from "../program";
import { getRpc, type RpcPool } from "../rpc";
import { sendTx } from "../tx";
import { conflict, KeyedLock, notFound, unavailable } from "./errors";

export interface CloseResult {
  market: string;
  signature: string;
  explorer: string;
}

export interface CloseDeps {
  rpc?: RpcPool;
  controller?: Keypair;
}

const lock = new KeyedLock();

export async function closeMarket(market: PublicKey, deps: CloseDeps = {}): Promise<CloseResult> {
  const rpc = deps.rpc ?? getRpc();
  const controller = deps.controller ?? loadKeypair("controller");
  return lock.with(market.toBase58(), async () => {
    const m = await rpc.run((c) => fetchMarket(getProgram(c), market));
    if (!m) throw notFound("Market not found");
    if (m.status !== "open") throw conflict(`Market is ${m.status}; only an Open market can be closed`);
    const config = await rpc.run((c) => getProgram(c).account.config.fetchNullable(configPda(getProgram(c))));
    if (!config) throw unavailable("Config is not initialized");
    if (!config.demoController.equals(controller.publicKey)) {
      throw unavailable("Configured controller key does not match config.demo_controller");
    }
    // Sends are never auto-retried on another endpoint (could double-send).
    const c = rpc.connection;
    const ix = await closeMarketIx(getProgram(c), { demoController: controller.publicKey, market });
    const signature = await sendTx(c, [ix], [controller]);
    return { market: market.toBase58(), signature, explorer: explorerTx(signature) };
  });
}
