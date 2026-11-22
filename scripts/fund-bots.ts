// Seed fresh market makers once and restore their SOL float when low (spec-simulation §3, §9).
//   node --env-file=app/.env.local --import tsx scripts/fund-bots.ts [--dry-run] [--minimum] [--from deployer|admin]
import { existsSync } from "node:fs";
import { createMintToInstruction } from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import {
  DEVNET_GENESIS, DemoTransactions, MAKER_CAPITAL, MAKER_SOL_FLOAT, ataOf, createAtaIdempotentIx,
  explorerTx, fetchExchangeConfig, formatMusd, getExchangeProgram, getRpc, loadKeypair, lockWorker, musdMint,
  readDemoFile, solToLamports,
} from "@metrex/server/exchange";
import { keypairPath } from "@metrex/server";
import { args, banner, DRY_RUN, flagValue, log, sol } from "./lib/common";

const MAKERS = ["botA", "botB", "botC"] as const;
const PROTECTED = ["homeownerDemo", "judge1", "judge2", "judge3"] as const;
const JOURNAL = "fund-bots-transactions.json";

async function main(): Promise<void> {
  banner("fund-bots");
  const fromName = flagValue("--from") ?? "deployer";
  if (fromName !== "deployer" && fromName !== "admin") throw new Error("--from must be deployer or admin");

  const rpc = getRpc();
  const genesis = await rpc.run((c) => c.getGenesisHash());
  const hostname = new URL(rpc.connection.rpcEndpoint).hostname;
  if (genesis !== DEVNET_GENESIS && !(args.includes("--local") && ["127.0.0.1", "localhost", "[::1]"].includes(hostname))) {
    throw new Error("Use Devnet or an explicit --local validator");
  }
  const mint = musdMint();
  const config = await rpc.run((c) => fetchExchangeConfig(getExchangeProgram(c), genesis === DEVNET_GENESIS ? "finalized" : "confirmed"));
  if (!config?.collateralMint.equals(mint)) throw new Error("mUSD mint does not match the initialized exchange");
  const funder = loadKeypair(fromName);
  const authority = loadKeypair("mintAuthority");
  const protectedKeys = PROTECTED.filter((name) => existsSync(keypairPath(name))).map((name) => loadKeypair(name).publicKey);
  const makers = MAKERS.map((name) => ({ name, owner: loadKeypair(name).publicKey }));
  const recipients = makers.map(({ owner }) => owner.toBase58());
  if (new Set(recipients).size !== MAKERS.length ||
    [...makers.map(({ owner }) => owner), funder.publicKey, authority.publicKey].some((key) => protectedKeys.some((p) => p.equals(key))) ||
    makers.some(({ owner }) => owner.equals(funder.publicKey) || owner.equals(authority.publicKey))) {
    throw new Error("Maker, funding and human wallet identities must be distinct");
  }

  // Serialize seed writes per mint across invocations. Reset Demo has its own explicit
  // restoration workflow. Live maker inventory and spend never determine a new mint here.
  const unlock = DRY_RUN ? undefined : await lockWorker(mint, [mint]);
  try {
    const journal = new DemoTransactions(rpc, JOURNAL);
    if (!DRY_RUN) await journal.recover();
    const records = readDemoFile<Record<string, { signature?: string; pending?: unknown }>>(JOURNAL) ?? {};
    const targetSol = args.includes("--minimum") ? solToLamports("0.03") : MAKER_SOL_FLOAT;
    const { context, value: infos } = await rpc.run((c) =>
      c.getMultipleAccountsInfoAndContext([funder.publicKey, ...makers.map(({ owner }) => owner)], "finalized"));
    let funderSol = BigInt(infos[0]?.lamports ?? 0);
    for (const [index, { name, owner }] of makers.entries()) {
      const have = BigInt(infos[index + 1]?.lamports ?? 0);
      if (have * 3n < targetSol * 2n) {
        const need = targetSol - have;
        if (funderSol - need < solToLamports("0.1")) throw new Error(`Insufficient funder SOL for ${name}`);
        funderSol -= need;
        log.todo(`${name} SOL ${sol(have)} → ${sol(targetSol)}`);
        if (!DRY_RUN) {
          const signature = await journal.send(`SOL ${genesis} ${owner} ${context.slot}`, async () => ({
            instructions: [SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: owner, lamports: need })],
            signers: [funder],
          }));
          if (signature) log.tx(`${name} SOL`, signature);
        }
      } else {
        log.ok(`${name}: ${sol(have)}`);
      }

      const ata = ataOf(mint, owner);
      const key = `seed ${genesis} ${mint} ${owner}`;
      const seeded = records[key]?.signature;
      if (seeded) {
        log.ok(`${name}: existing seed ${explorerTx(seeded)}`);
        continue;
      }
      if (records[key]?.pending) {
        log.warn(`${name} has a pending seed. A funding run will recover that transaction.`);
        continue;
      }
      // A used ATA can have zero free collateral or even have been closed. Treat it as
      // previously provisioned, including makers seeded by the original V7 migration.
      const existing = await rpc.run((c) => c.getAccountInfo(ata, "finalized"));
      if (existing || (await rpc.run((c) => c.getSignaturesForAddress(ata, { limit: 1 }, "finalized"))).length) {
        log.ok(`${name}: existing mUSD account history, seed skipped`);
        continue;
      }
      log.todo(`${name}: seed ${formatMusd(MAKER_CAPITAL)} mUSD`);
      if (!DRY_RUN) {
        const signature = await journal.send(key, async () => ({
          instructions: [
            createAtaIdempotentIx(funder.publicKey, owner, mint),
            createMintToInstruction(mint, ata, authority.publicKey, MAKER_CAPITAL),
          ],
          signers: [funder, authority],
        }));
        if (signature) log.tx(`${name} mUSD seed`, signature);
      }
    }
  } finally {
    unlock?.();
  }
}

main().catch((e: unknown) => {
  console.error(`fund-bots failed: ${(e as Error).message}`);
  process.exitCode = 1;
});
