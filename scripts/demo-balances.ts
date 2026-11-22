// Read-only funding report (docs/spec-simulation.md §4): SOL and mUSD of every operator wallet,
// the sponsor and the simulated population. Prints public keys and balances only, never secrets.
//   node --env-file=app/.env.local --import tsx scripts/demo-balances.ts
import { getRpc, loadKeypair, musdAta, musdMint, type KeypairName } from "@metrex/server";
import { tokenAmountOf } from "@metrex/server/exchange";
import { readPopulation } from "../services/sim/src/keys";
import type { PublicKey } from "@solana/web3.js";

async function main(): Promise<void> {
  const conn = getRpc().connection;
  const mint = musdMint();
  const names: KeypairName[] = ["deployer", "admin", "mintAuthority", "controller", "oracle", "keeper", "faucet", "botA", "botB", "botC", "homeownerDemo", "judge1", "judge2", "judge3", "simSponsor"];
  const rows: Array<{ name: string; pk: PublicKey }> = [];
  for (const n of names) {
    try { rows.push({ name: n, pk: loadKeypair(n).publicKey }); } catch { console.log(`${n.padEnd(14)} (no key on this host)`); }
  }
  const pop = readPopulation();
  const { PublicKey: PK } = await import("@solana/web3.js");
  const sims = pop.map((p) => ({ name: p.id, pk: new PK(p.address) }));
  const all = [...rows, ...sims];
  const keys = all.flatMap((r) => [r.pk, musdAta(r.pk, mint)]);
  const infos = [];
  for (let i = 0; i < keys.length; i += 100) infos.push(...(await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")));
  const sol = (i: number) => (infos[2 * i]?.lamports ?? 0) / 1e9;
  const usd = (i: number) => Number(tokenAmountOf(infos[2 * i + 1])) / 1e6;
  rows.forEach((r, i) => console.log(`${r.name.padEnd(14)} ${r.pk.toBase58()} ${sol(i).toFixed(4).padStart(9)} SOL ${usd(i).toLocaleString().padStart(12)} mUSD`));
  const off = rows.length;
  const simSol = sims.reduce((s, _, j) => s + sol(off + j), 0);
  const simUsd = sims.reduce((s, _, j) => s + usd(off + j), 0);
  const withAta = sims.filter((_, j) => infos[2 * (off + j) + 1] !== null).length;
  console.log(`simulated      ${sims.length} wallets, ${withAta} with mUSD accounts, ${simSol.toFixed(4)} SOL, ${simUsd.toLocaleString()} mUSD free`);
}
main().catch((e: unknown) => { console.error((e as Error).message); process.exit(1); });
