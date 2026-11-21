// Close-and-settle for one round (spec-v2 §10.6 workflow, §12 step 2). Resumable: every step reads
// chain state first and skips what is already done. Each on-chain step is its own transaction.

import type { Keypair } from "@solana/web3.js";
import { closeRoundIx } from "../exchange/ix";
import { fetchExchangeConfig, fetchMarketsOfRound, fetchRound, chainNow, type RoundView } from "../exchange/accounts";
import { loadMarketBook } from "../exchange/book";
import { Keeper } from "../exchange/keeper";
import { getExchangeProgram } from "../exchange/program";
import { sendExchangeTx } from "../exchange";
import { getRpc, type RpcPool } from "../rpc";
import { expireExchangeMarket, resolutionDeadline, resolveExchangeMarket } from "./exchange";

export interface SettleStep {
  step: "close" | "resolve" | "expire" | "sweep" | "skip";
  target: string;
  signature: string | null;
  note?: string;
}

export interface SettleDeps {
  rpc?: RpcPool;
  controller: Keypair;
  oracle: Keypair;
  /** Pays sweeps (§7.4). Omit to leave sweeping to the keeper process. */
  keeper?: Keypair;
  dataDir?: string;
  log?: (s: SettleStep) => void;
}

export async function settleRound(roundAddress: RoundView["address"], deps: SettleDeps): Promise<SettleStep[]> {
  const rpc = deps.rpc ?? getRpc();
  const steps: SettleStep[] = [];
  const record = (s: SettleStep) => {
    steps.push(s);
    deps.log?.(s);
  };
  const prog = () => getExchangeProgram(rpc.connection);
  let round = await rpc.run((c) => fetchRound(getExchangeProgram(c), roundAddress, "finalized"));
  if (!round) throw new Error(`Round ${roundAddress.toBase58()} not found`);

  // 1. close_round (skipped if already Closed), finalized.
  if (round.status === "open") {
    const sig = await sendExchangeTx(rpc.connection, [await closeRoundIx(prog(), deps.controller.publicKey, round.address)], [deps.controller], {
      commitment: "finalized",
    });
    record({ step: "close", target: round.address.toBase58(), signature: sig });
    round = await rpc.run((c) => fetchRound(getExchangeProgram(c), roundAddress, "finalized"));
    if (!round || round.status !== "closed") throw new Error("close_round did not finalize; retry");
  } else {
    record({ step: "skip", target: round.address.toBase58(), signature: null, note: "already closed" });
  }

  // 2. Oracle resolution per market inside the window, else the permissionless expiry.
  const config = await rpc.run((c) => fetchExchangeConfig(getExchangeProgram(c), "finalized"));
  if (!config) throw new Error("Config not found");
  const markets = await rpc.run((c) => fetchMarketsOfRound(getExchangeProgram(c), roundAddress));
  for (const m of markets) {
    if (m.outcome !== "unresolved") {
      // Verify evidence for an already resolved YES/NO market (idempotent retry); Invalid needs none.
      if (m.outcome === "yes" || m.outcome === "no") {
        const r = await resolveExchangeMarket(m.address, { rpc, oracle: deps.oracle, dataDir: deps.dataDir });
        record({ step: "skip", target: m.address.toBase58(), signature: null, note: `already resolved, evidence ${r.hashHex}` });
      } else record({ step: "skip", target: m.address.toBase58(), signature: null, note: "already Invalid" });
      continue;
    }
    const now = await rpc.run((c) => chainNow(c, "finalized"));
    if (now >= resolutionDeadline(round, config)) {
      const sig = await expireExchangeMarket(m, deps.oracle, rpc);
      record({ step: "expire", target: m.address.toBase58(), signature: sig, note: "resolution window closed" });
      continue;
    }
    const r = await resolveExchangeMarket(m.address, { rpc, oracle: deps.oracle, dataDir: deps.dataDir });
    record({ step: "resolve", target: m.address.toBase58(), signature: r.signature, note: `evidence ${r.hashHex}` });
  }

  // 3. Sweep remaining orders (permissionless; rent and escrow return to makers).
  if (deps.keeper) {
    const keeper = new Keeper({ rpc, keeper: deps.keeper, log: () => undefined });
    for (const m of markets) {
      const snap = await rpc.run((c) => loadMarketBook(c, m.address, config.collateralMint));
      if (!snap) continue;
      const n = await keeper.sweepMarket(snap, config.collateralMint);
      if (n) record({ step: "sweep", target: m.address.toBase58(), signature: keeper.stats.lastSignature, note: `${n} orders` });
    }
  }
  return steps;
}
