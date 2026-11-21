// fund-bots.ts (spec §9.4, §14): top up SOL and mUSD for bots, the faucet wallet, the demo
// homeowner, judges, and the oracle/controller fee payers. Idempotent: only the shortfall
// to each target is sent; balances are checked first.
//   pnpm tsx scripts/fund-bots.ts [--dry-run] [--from deployer|admin]

import { createMintToInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SystemProgram, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import {
  createAtaIdempotentIx,
  formatMusd,
  getMusdBalance,
  getRpc,
  getSolLamports,
  loadKeypair,
  musd,
  musdAta,
  musdMint,
  sendTx,
  solToLamports,
  type KeypairName,
} from "@metrex/server";
import { banner, DRY_RUN, exitWith, flagValue, log, sol } from "./lib/common";

interface Target {
  name: KeypairName;
  sol: bigint;
  musd: bigint;
}

/** Priority order: if the funder runs short, earlier wallets are funded first. */
export const TARGETS: readonly Target[] = [
  { name: "botA", sol: solToLamports("1.5"), musd: musd(250_000n) },
  { name: "botB", sol: solToLamports("1.5"), musd: musd(250_000n) },
  { name: "botC", sol: solToLamports("1.5"), musd: musd(250_000n) },
  { name: "homeownerDemo", sol: solToLamports("0.5"), musd: musd(100_000n) },
  { name: "oracle", sol: solToLamports("0.05"), musd: 0n },
  { name: "controller", sol: solToLamports("0.05"), musd: 0n },
  { name: "faucet", sol: solToLamports("5"), musd: 0n },
  { name: "judge1", sol: solToLamports("0.1"), musd: musd(25_000n) },
  { name: "judge2", sol: solToLamports("0.1"), musd: musd(25_000n) },
  { name: "judge3", sol: solToLamports("0.1"), musd: musd(25_000n) },
];

/** Keep this much in the funder for fees and ATA rent. */
const FUNDER_RESERVE = solToLamports("0.1");

async function main(): Promise<void> {
  banner("fund-bots");
  const fromName = (flagValue("--from") ?? "deployer") as KeypairName;
  if (fromName !== "deployer" && fromName !== "admin") throw new Error("--from must be deployer or admin");
  const conn = getRpc().connection;
  const funder = loadKeypair(fromName);
  const mintAuthority = loadKeypair("mintAuthority");
  const mint = musdMint();
  let problems = 0;

  let funderSol = await getSolLamports(conn, funder.publicKey);
  console.log(`  funder  ${fromName} ${funder.publicKey.toBase58()} (${sol(funderSol)})`);
  console.log(`  mint    ${mint.toBase58()}`);

  const wallets = TARGETS.map((t) => ({ ...t, pk: loadKeypair(t.name).publicKey }));

  // ---------- SOL ----------
  log.step("SOL top-ups");
  const solIxs: TransactionInstruction[] = [];
  for (const w of wallets) {
    if (w.pk.equals(funder.publicKey)) continue;
    const bal = await getSolLamports(conn, w.pk);
    const need = w.sol > bal ? w.sol - bal : 0n;
    if (need === 0n) {
      log.ok(`${w.name} ${sol(bal)} ≥ ${sol(w.sol)}`);
      continue;
    }
    if (funderSol - need < FUNDER_RESERVE) {
      log.fail(`${w.name} needs ${sol(need)} but ${fromName} has ${sol(funderSol)} (reserve ${sol(FUNDER_RESERVE)})`);
      problems++;
      continue;
    }
    funderSol -= need;
    log.todo(`${w.name}: +${sol(need)} → ${sol(w.sol)}`);
    solIxs.push(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: w.pk, lamports: need }));
  }
  if (!DRY_RUN) {
    for (let i = 0; i < solIxs.length; i += 8) {
      log.tx("SOL transfers", await sendTx(conn, solIxs.slice(i, i + 8), [funder]));
    }
  }

  // ---------- mUSD ----------
  log.step("mUSD top-ups (minted by mint-authority; funder pays fees and ATA rent)");
  if (funderSol < FUNDER_RESERVE) {
    log.fail(`${fromName} has ${sol(funderSol)}; needs ≥ ${sol(FUNDER_RESERVE)} for mint fees and ATA rent`);
    problems++;
  }
  const mintIxs: TransactionInstruction[][] = [];
  for (const w of wallets) {
    if (w.musd === 0n) continue;
    const bal = await getMusdBalance(conn, w.pk, mint);
    const need = w.musd > bal ? w.musd - bal : 0n;
    if (need === 0n) {
      log.ok(`${w.name} ${formatMusd(bal)} mUSD ≥ ${formatMusd(w.musd)}`);
      continue;
    }
    log.todo(`${w.name}: mint ${formatMusd(need)} mUSD → ${formatMusd(w.musd)}`);
    mintIxs.push(mintTo(funder.publicKey, mintAuthority.publicKey, mint, w.pk, need));
  }
  if (!DRY_RUN) {
    for (let i = 0; i < mintIxs.length; i += 4) {
      const ixs = mintIxs.slice(i, i + 4).flat();
      log.tx("mUSD mints", await sendTx(conn, ixs, [funder, mintAuthority]));
    }
  }
  exitWith(problems);
}

function mintTo(payer: PublicKey, authority: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint) {
  return [
    createAtaIdempotentIx(payer, owner, mint),
    createMintToInstruction(mint, musdAta(owner, mint), authority, amount, [], TOKEN_PROGRAM_ID),
  ];
}

main().catch((e: unknown) => {
  console.error(`fund-bots failed: ${(e as Error).message}`);
  process.exit(1);
});
