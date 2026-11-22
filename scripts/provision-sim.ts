// provision-sim.ts (docs/spec-simulation.md §2, §4): create the simulated trader wallets, mint each
// one's starting capital exactly once, give limit-posting traders a small SOL float for order rent,
// and top up the sponsor that pays every simulator fee. Idempotent and safe to re-run: a trader
// that was ever funded is never topped back up (finite capital).
//   pnpm tsx scripts/provision-sim.ts [--dry-run] [--traders 100] [--sponsor-sol 2] [--from deployer|admin]

import { createMintToInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, SystemProgram, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { createAtaIdempotentIx, formatMusd, getRpc, loadKeypair, musdAta, musdMint, solToLamports, type KeypairName } from "@metrex/server";
import { DemoTransactions, DEVNET_GENESIS, SIM_SOL_FLOAT, exchangeProgramId, fullResetHeld, keyDir, lockWorker, tokenAmountOf } from "@metrex/server/exchange";
import { ensureTrader, readFunding, writeFunding, writePopulation } from "../services/sim/src/keys";
import { ARCHETYPE_LABEL, generatePopulation } from "../services/sim/src/population";
import { args, banner, DRY_RUN, exitWith, flagValue, log, sol } from "./lib/common";

const SEED = process.env.SIM_SEED ?? "metrex-v7";
/** Order-rent float for traders that post limit orders (about four resting orders; cancel refunds it). */
const LIMIT_FLOAT = SIM_SOL_FLOAT;
const FUNDER_RESERVE = solToLamports("0.1");

async function main(): Promise<void> {
  banner("provision-sim");
  const n = Math.min(100, Number(flagValue("--traders") ?? 100));
  if (!Number.isInteger(n) || n < 1) throw new Error("--traders must be 1–100");
  const sponsorTarget = solToLamports(flagValue("--sponsor-sol") ?? "2");
  const fromName = (flagValue("--from") ?? "deployer") as KeypairName;
  if (fromName !== "deployer" && fromName !== "admin") throw new Error("--from must be deployer or admin");
  const rpc = getRpc();
  if (await rpc.run((c) => c.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("Provisioning requires Devnet");
  const funder = loadKeypair(fromName);
  const mintAuthority = loadKeypair("mintAuthority");
  const sponsorPath = join(keyDir(), "sim-sponsor.json");
  if (!DRY_RUN && !process.env.SIM_SPONSOR_KEYPAIR && !existsSync(sponsorPath)) {
    writeFileSync(sponsorPath, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600, flag: "wx" });
    log.ok(`created sponsor keypair ${sponsorPath}`);
  }
  const unlock = DRY_RUN ? () => undefined : await lockWorker(exchangeProgramId(), [loadKeypair("simSponsor").publicKey]);
  try {
    if (fullResetHeld()) throw new Error("Finish the active demo reset before provisioning");
    const journal = new DemoTransactions(rpc, "provision-transactions.json");
    if (!DRY_RUN) await journal.recover();
    const mint = musdMint();

    log.step(`population (seed ${SEED}, ${n} traders)`);
    const profiles = generatePopulation(SEED, 100).slice(0, n);
    const wallets = profiles.map((p) => {
      const { keypair, created } = DRY_RUN ? { keypair: null, created: false } : ensureTrader(p.index);
      if (created) log.ok(`created ${p.id} (${ARCHETYPE_LABEL[p.archetype]})`);
      return { p, pk: keypair?.publicKey ?? null };
    });
    if (DRY_RUN) {
      const total = profiles.reduce((s, p) => s + p.capital, 0n);
      log.todo(`create up to ${n} trader keypairs under $METREX_KEY_DIR/sim and mint ${formatMusd(total)} mUSD in total`);
      exitWith(0);
      return;
    }
    const sponsor = loadKeypair("simSponsor");
    const ready = wallets.filter((w): w is { p: (typeof profiles)[number]; pk: PublicKey } => w.pk !== null);
    writePopulation(ready.map(({ p, pk }) => ({ index: p.index, id: p.id, archetype: p.archetype, address: pk.toBase58(), capitalMusd: (p.capital / 1_000_000n).toString() })));
    log.ok(`population.json: ${ready.length} public records`);

    // One batched read: SOL and mUSD ATA of every trader, plus the sponsor and funder.
    const keys = [funder.publicKey, sponsor.publicKey, ...ready.flatMap((w) => [w.pk, musdAta(w.pk, mint)])];
    const infos = new Map<string, Awaited<ReturnType<typeof rpc.connection.getAccountInfo>>>();
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      (await rpc.run((c) => c.getMultipleAccountsInfo(chunk, "finalized"))).forEach((a, j) => infos.set(chunk[j]!.toBase58(), a));
    }
    const lamports = (k: PublicKey) => BigInt(infos.get(k.toBase58())?.lamports ?? 0);
    let funderSol = lamports(funder.publicKey);
    console.log(`  funder  ${fromName} ${funder.publicKey.toBase58()} (${sol(funderSol)})`);
    console.log(`  sponsor ${sponsor.publicKey.toBase58()} (${sol(lamports(sponsor.publicKey))})`);

    log.step("SOL: sponsor and limit-order rent floats");
    const funding = readFunding();
    const want: Array<[string, PublicKey, bigint]> = [["sponsor", sponsor.publicKey, sponsorTarget], ...ready.filter((w) => w.p.postsLimits && !funding[w.pk.toBase58()]).map((w): [string, PublicKey, bigint] => [w.p.id, w.pk, LIMIT_FLOAT])];
    const batches = [want.slice(0, 1)];
    for (let i = 1; i < want.length; i += 10) batches.push(want.slice(i, i + 10));
    for (const batch of batches) {
      const sig = await journal.send(`SOL ${batch.map(([name]) => name).join("+")}`, async () => {
        const instructions: TransactionInstruction[] = [];
        for (const [name, pk, target] of batch) {
          const need = target > lamports(pk) ? target - lamports(pk) : 0n;
          if (!need) continue;
          if (funderSol - need < FUNDER_RESERVE) throw new Error(`${name} needs ${sol(need)} but ${fromName} has ${sol(funderSol)}`);
          funderSol -= need;
          instructions.push(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: pk, lamports: need }));
        }
        return instructions.length ? { instructions, signers: [funder] } : null;
      });
      if (sig) log.tx("SOL funding receipt", sig);
    }

    log.step("mUSD: starting capital, minted once per wallet");
    // Fixed batch boundaries let a partially recorded mint resume with the same transaction key.
    for (let i = 0; i < ready.length; i += 4) {
      const batch = ready.slice(i, i + 4);
      if (batch.every(({ pk }) => funding[pk.toBase58()])) continue;
      const missing = batch.filter(({ pk }) => !funding[pk.toBase58()]);
      const sig = await journal.send(`mUSD ${i / 4} ${missing.map(({ p }) => p.id).join("+")}`, async () => {
        const instructions = missing.flatMap(({ p, pk }) => {
          const addr = musdAta(pk, mint);
          if (infos.get(addr.toBase58())) return [];
          return [
            createAtaIdempotentIx(funder.publicKey, pk, mint),
            createMintToInstruction(mint, addr, mintAuthority.publicKey, p.capital, [], TOKEN_PROGRAM_ID),
          ];
        });
        return instructions.length ? { instructions, signers: [funder, mintAuthority] } : null;
      });
      for (const { p, pk } of missing) {
        const ata = infos.get(musdAta(pk, mint).toBase58());
        funding[pk.toBase58()] = {
          musd: (sig ? p.capital : tokenAmountOf(ata)).toString(),
          at: new Date().toISOString(),
          signature: sig ?? null,
        };
      }
      writeFunding(funding);
      if (sig) log.tx(`mint batch ${i / 4 + 1}`, sig);
    }
    const total = ready.reduce((s, w) => s + BigInt(funding[w.pk.toBase58()]?.musd ?? "0"), 0n);
    log.ok(`${Object.keys(funding).length} wallets funded once, ${formatMusd(total)} mUSD starting capital in this population`);
    if (args.includes("--verbose")) for (const w of ready) console.log(`  ${w.p.id} ${w.p.archetype.padEnd(9)} ${w.pk.toBase58()}`);
    exitWith(0);
  } finally {
    unlock();
  }
}

main().catch((e: unknown) => {
  console.error(`provision-sim failed: ${(e as Error).message}`);
  process.exit(1);
});
