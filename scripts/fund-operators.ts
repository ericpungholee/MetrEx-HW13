// fund-operators.ts: top up the SOL of the round controller, oracle, keeper and simulator fee
// sponsor from the deployer, only when below target (idempotent). Rounds, markets, settlements and
// simulator fees are paid by these wallets (docs/spec-simulation.md §4, §9). Devnet only; never touches mUSD or any human wallet.
//   pnpm tsx scripts/fund-operators.ts [--dry-run]
import { SystemProgram } from "@solana/web3.js";
import { getRpc, loadKeypair, sendExchangeTx, solToLamports, DEVNET_GENESIS, type KeypairName } from "@metrex/server/exchange";
import { banner, DRY_RUN, exitWith, log, sol } from "./lib/common";

const TARGETS: Array<[KeypairName, bigint]> = [
  ["controller", solToLamports("0.5")],
  ["oracle", solToLamports("0.3")],
  ["keeper", solToLamports("0.5")],
  // Simulator fee sponsor: about 2.8 SOL of fees a week at ~30 tx/min plus reclaimable account rent.
  ["simSponsor", solToLamports(process.env.SIM_SPONSOR_SOL ?? "5")],
];

async function main(): Promise<void> {
  banner("fund-operators");
  const rpc = getRpc();
  if (await rpc.run((c) => c.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("Devnet only");
  const deployer = loadKeypair("deployer");
  const ixs = [];
  for (const [name, target] of TARGETS) {
    const k = loadKeypair(name).publicKey;
    const have = BigInt(await rpc.run((c) => c.getBalance(k, "finalized")));
    if (have * 10n >= target * 9n) {
      log.ok(`${name} ${sol(have)}`);
      continue;
    }
    log.todo(`${name} ${sol(have)} → ${sol(target)}`);
    ixs.push(SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: k, lamports: target - have }));
  }
  if (ixs.length && !DRY_RUN) log.tx("top-up", await sendExchangeTx(rpc.connection, ixs, [deployer], { commitment: "finalized" }));
  exitWith(0);
}

main().catch((e: unknown) => {
  console.error(`fund-operators failed: ${(e as Error).message}`);
  process.exit(1);
});
