// seed-demo.ts (spec §9.4, §14): a fallback market on property 1 from homeowner-demo, with
// the three bot offers (§7 sizes and rates) placed and accepted in one transaction.
// Idempotent: the market uses a fixed nonce, so its address is deterministic; each step
// checks on-chain state (market exists? bot already offered? already accepted?) and resumes.
//   pnpm tsx scripts/seed-demo.ts [--dry-run]
// Tip: stop the bot worker while seeding, or let it place the offers and this script accepts them.

import { findMarketPda, findPropertyPda, randomNonce, MUSD_UNIT, computeOfferTerms } from "@metrex/shared";
import {
  acceptOfferIx,
  createMarketIx,
  explorerAddress,
  fetchMarket,
  fetchOffers,
  filters,
  formatMusd,
  getMusdBalance,
  getProgram,
  getRpc,
  getSolLamports,
  loadKeypair,
  musdMint,
  placeOfferIx,
  sendTx,
  type OfferView,
} from "@metrex/server";
import { BOTS, MIN_SOL_LAMPORTS } from "../services/bots/src/params";
import { offerCoverage } from "../services/bots/src/strategy";
import { banner, DRY_RUN, exitWith, log } from "./lib/common";

/** Fixed nonce ("seed" + 1) so the fallback market's PDA is deterministic. */
export const SEED_MARKET_NONCE = 0x5eed_0000_0000_0001n;
export const SEED_PROPERTY_ID = 1;
export const SEED_COVERAGE_TARGET = 10_000n * MUSD_UNIT;

async function main(): Promise<void> {
  banner("seed-demo");
  const conn = getRpc().connection;
  const program = getProgram(conn);
  const pid = program.programId;
  const mint = musdMint();
  const homeowner = loadKeypair("homeownerDemo");
  const bots = BOTS.map((p) => ({ params: p, kp: loadKeypair(p.keypair) }));
  const [marketPk] = findMarketPda(pid, homeowner.publicKey, SEED_MARKET_NONCE);
  let problems = 0;
  console.log(`  homeowner ${homeowner.publicKey.toBase58()}`);
  console.log(`  market    ${marketPk.toBase58()} (property ${SEED_PROPERTY_ID}, nonce ${SEED_MARKET_NONCE})`);

  // ---------- 1. market ----------
  log.step("fallback market");
  let market = await fetchMarket(program, marketPk);
  if (!market) {
    const prop = await program.account.property.fetchNullable(findPropertyPda(pid, SEED_PROPERTY_ID)[0]);
    if (!prop) {
      log.fail(`property ${SEED_PROPERTY_ID} is not registered; run scripts/setup-devnet.ts first`);
      exitWith(1);
    }
    if (DRY_RUN) {
      log.todo(`create_market(${SEED_MARKET_NONCE}, ${SEED_PROPERTY_ID}, ${formatMusd(SEED_COVERAGE_TARGET)} mUSD)`);
      log.todo("then place 3 bot offers and accept them");
      exitWith(0);
    }
    const ix = await createMarketIx(program, {
      homeowner: homeowner.publicKey,
      marketNonce: SEED_MARKET_NONCE,
      propertyId: SEED_PROPERTY_ID,
      coverageTarget: SEED_COVERAGE_TARGET,
    });
    log.tx("create_market", await sendTx(conn, [ix], [homeowner]));
    market = await fetchMarket(program, marketPk);
    if (!market) throw new Error("market not visible after creation");
  } else {
    log.ok(`exists (status ${market.status}, ${formatMusd(market.coverageActivated)}/${formatMusd(market.coverageTarget)} mUSD activated)`);
  }
  log.addr("market", marketPk);
  if (market.status !== "open") {
    log.ok(`market is ${market.status}; nothing more to seed`);
    exitWith(0);
  }
  if (market.coverageActivated >= market.coverageTarget) {
    log.ok("already fully funded with accepted positions");
    exitWith(0);
  }

  // ---------- 2. bot offers ----------
  log.step("bot offers (§7: A 40% @ 400, B 30% @ 450, C 30% @ 500)");
  for (const b of bots) {
    const existing = await fetchOffers(program, [filters.offerMarket(marketPk), filters.offerUnderwriter(b.kp.publicKey)]);
    if (existing.length > 0) {
      log.ok(`${b.params.id}: already offered (${existing.map((o) => `${formatMusd(o.coverage)} @ ${o.premiumBps} ${o.status}`).join(", ")})`);
      continue;
    }
    const coverage = offerCoverage(b.params, market.coverageTarget, 0n);
    if (coverage === null) {
      log.fail(`${b.params.id}: no valid offer size`);
      problems++;
      continue;
    }
    const { collateral } = computeOfferTerms(coverage, b.params.bps);
    const [musdBal, solBal] = await Promise.all([
      getMusdBalance(conn, b.kp.publicKey, mint),
      getSolLamports(conn, b.kp.publicKey),
    ]);
    if (musdBal < collateral || solBal < MIN_SOL_LAMPORTS) {
      log.fail(`${b.params.id}: needs ${formatMusd(collateral)} mUSD and 0.01 SOL; run scripts/fund-bots.ts`);
      problems++;
      continue;
    }
    if (DRY_RUN) {
      log.todo(`${b.params.id}: place_offer ${formatMusd(coverage)} mUSD @ ${b.params.bps} bps`);
      continue;
    }
    const ix = await placeOfferIx(program, {
      underwriter: b.kp.publicKey,
      market: marketPk,
      offerNonce: randomNonce(),
      coverage,
      premiumBps: b.params.bps,
      mint,
    });
    log.tx(`${b.params.id} place_offer`, await sendTx(conn, [ix], [b.kp]));
  }

  // ---------- 3. accept ----------
  log.step("accept bot offers (one transaction, §10.3)");
  const botKeys = new Set(bots.map((b) => b.kp.publicKey.toBase58()));
  const open = (await fetchOffers(program, [filters.offerMarket(marketPk), filters.offerStatus("open")]))
    .filter((o) => botKeys.has(o.underwriter.toBase58()))
    .sort((a, b) => a.premiumBps - b.premiumBps);
  let activated = market.coverageActivated;
  const chosen: OfferView[] = [];
  for (const o of open) {
    if (activated + o.coverage > market.coverageTarget) continue;
    activated += o.coverage;
    chosen.push(o);
  }
  if (chosen.length === 0) {
    log.ok("no open bot offers to accept");
    exitWith(problems);
  }
  const premiums = chosen.reduce((s, o) => s + o.premium, 0n);
  const homeMusd = await getMusdBalance(conn, homeowner.publicKey, mint);
  if (homeMusd < premiums) {
    log.fail(`homeowner-demo has ${formatMusd(homeMusd)} mUSD, needs ${formatMusd(premiums)} for premiums; run scripts/fund-bots.ts`);
    exitWith(problems + 1);
  }
  for (const o of chosen) log.todo(`accept ${o.pubkey.toBase58()} (${formatMusd(o.coverage)} @ ${o.premiumBps} bps, premium ${formatMusd(o.premium)})`);
  if (!DRY_RUN) {
    const ixs = await Promise.all(
      chosen.map((o) => acceptOfferIx(program, { homeowner: homeowner.publicKey, market: marketPk, offer: o.pubkey, mint })),
    );
    log.tx("accept_offer ×" + ixs.length, await sendTx(conn, ixs, [homeowner]));
    const after = await fetchMarket(program, marketPk);
    if (after) log.ok(`activated ${formatMusd(after.coverageActivated)}/${formatMusd(after.coverageTarget)} mUSD, ${after.acceptedCount} positions`);
  }
  console.log(`\n  Fallback market: ${explorerAddress(marketPk)}`);
  exitWith(problems);
}

main().catch((e: unknown) => {
  console.error(`seed-demo failed: ${(e as Error).message}`);
  process.exit(1);
});
