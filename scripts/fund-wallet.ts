// fund-wallet.ts <pubkey> (spec §9.3 as a script): top the wallet up to 0.05 SOL (from the
// faucet wallet) and 25,000 mUSD (minted). Idempotent: sends only the shortfall.
//   pnpm tsx scripts/fund-wallet.ts <pubkey> [--dry-run]

import {
  FAUCET_MUSD,
  FAUCET_SOL_LAMPORTS,
  faucetInstructions,
  formatMusd,
  getMusdBalance,
  getRpc,
  getSolLamports,
  loadKeypair,
  musdMint,
  parsePublicKey,
  sendTx,
} from "@metrex/server";
import { args, banner, DRY_RUN, exitWith, log, sol } from "./lib/common";

async function main(): Promise<void> {
  const target = args.find((a) => !a.startsWith("--"));
  if (!target) {
    console.error("usage: pnpm tsx scripts/fund-wallet.ts <pubkey> [--dry-run]");
    process.exit(2);
  }
  const wallet = parsePublicKey(target, "wallet address");
  banner("fund-wallet");
  const conn = getRpc().connection;
  const faucet = loadKeypair("faucet");
  const mintAuthority = loadKeypair("mintAuthority");
  const mint = musdMint();

  const [solBal, musdBal, faucetSol] = await Promise.all([
    getSolLamports(conn, wallet),
    getMusdBalance(conn, wallet, mint),
    getSolLamports(conn, faucet.publicKey),
  ]);
  const solNeed = FAUCET_SOL_LAMPORTS > solBal ? FAUCET_SOL_LAMPORTS - solBal : 0n;
  const musdNeed = FAUCET_MUSD > musdBal ? FAUCET_MUSD - musdBal : 0n;
  console.log(`  wallet  ${wallet.toBase58()}: ${sol(solBal)}, ${formatMusd(musdBal)} mUSD`);
  console.log(`  faucet  ${faucet.publicKey.toBase58()}: ${sol(faucetSol)}`);

  log.step("top-up");
  if (solNeed === 0n && musdNeed === 0n) {
    log.ok("already at ≥ 0.05 SOL and ≥ 25,000 mUSD");
    exitWith(0);
  }
  if (solNeed > 0n && faucetSol < solNeed + 10_000_000n) {
    log.fail(`faucet wallet has ${sol(faucetSol)}; replenish its Devnet SOL before funding wallets`);
    exitWith(1);
  }
  if (solNeed > 0n) log.todo(`+${sol(solNeed)}`);
  if (musdNeed > 0n) log.todo(`mint ${formatMusd(musdNeed)} mUSD`);
  if (!DRY_RUN) {
    const ixs = faucetInstructions({
      faucet: faucet.publicKey,
      mintAuthority: mintAuthority.publicKey,
      mint,
      wallet,
      solLamports: solNeed,
      musdAmount: musdNeed,
    });
    log.tx("fund", await sendTx(conn, ixs, musdNeed > 0n ? [faucet, mintAuthority] : [faucet]));
  }
  exitWith(0);
}

main().catch((e: unknown) => {
  console.error(`fund-wallet failed: ${(e as Error).message}`);
  process.exit(1);
});
