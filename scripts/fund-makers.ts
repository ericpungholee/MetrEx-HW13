// fund-makers.ts (docs/spec-simulation.md §3, §9): raise each maker's seeded mUSD from the original
// V7 seed to MAKER_CAPITAL with one journaled Devnet mint per maker. Runs once: the journal key names
// the target, so a rerun sends nothing. It never burns, never touches rounds, simulated traders or
// any human wallet, and needs no reset. Later Reset Demo runs restore makers to MAKER_CAPITAL.
//   pnpm tsx scripts/fund-makers.ts [--dry-run]
import { createMintToInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  DemoTransactions, DEVNET_GENESIS, MAKER_CAPITAL, MAKER_CAPITAL_V7_SEED, ataOf, explorerTx, getRpc, loadKeypair, musdMint, tokenAmountOf,
} from "@metrex/server/exchange";
import { banner, DRY_RUN, exitWith, log } from "./lib/common";

async function main(): Promise<void> {
  banner("fund-makers");
  const rpc = getRpc();
  if (await rpc.run((c) => c.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("Devnet only");
  const raise = MAKER_CAPITAL - MAKER_CAPITAL_V7_SEED;
  if (raise <= 0n) return exitWith(0);
  const mint = musdMint();
  const journal = new DemoTransactions(rpc, "maker-capital-transactions.json");
  await journal.recover();
  const deployer = loadKeypair("deployer");
  const mintAuthority = loadKeypair("mintAuthority");
  for (const name of ["botA", "botB", "botC"] as const) {
    const ata = ataOf(mint, loadKeypair(name).publicKey);
    const before = tokenAmountOf(await rpc.run((c) => c.getAccountInfo(ata, "finalized")));
    const key = `raise ${name} to ${MAKER_CAPITAL}`;
    if (DRY_RUN) {
      log.todo(`${name}: mint ${raise / 1_000_000n} mUSD (free now ${before / 1_000_000n}) unless journaled as "${key}"`);
      continue;
    }
    const sig = await journal.send(key, async () => ({
      instructions: [createMintToInstruction(mint, ata, mintAuthority.publicKey, raise, [], TOKEN_PROGRAM_ID)],
      signers: [deployer, mintAuthority],
    }));
    log.ok(`${name}: +${raise / 1_000_000n} mUSD ${sig ? explorerTx(sig) : ""}`);
  }
  exitWith(0);
}

main().catch((e: unknown) => {
  console.error(`fund-makers failed: ${(e as Error).message}`);
  process.exit(1);
});
