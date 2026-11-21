// prepare-demo-v2.ts (spec-v2 §12): settle any stale wildfire round, open a fresh round with markets for
// properties 1 and 2, wait for the bots, and verify the demo ladder. Multi-peril (docs/spec-multiperil.md
// §2.2): other hazards' rounds may be open at the same time, so this script only looks at scenario 1
// rounds and never touches the others (scripts/prepare-multiperil.ts opens those). Idempotent. Never evaluates or
// prints a settlement outcome before that market's finalized resolution.
//   pnpm tsx scripts/prepare-demo-v2.ts [--local] [--hours 24] [--wait 60] [--no-wait]
// Run fund-bots.ts first; start the v2 bots (`pnpm --filter bots start:v2`) and the keeper
// (`pnpm --filter indexer start:v2`) so step 5 can see their quotes and heartbeats.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { DEMO_BOTS, MUSD_UNIT, SCENARIO_PALISADES_2025, catalogByProperty, findRoundPda, marketAddresses } from "@metrex/exchange";
import { encodeLabel, type ScenarioRegistry } from "@metrex/shared";
import {
  createMarketIx,
  createRoundIx,
  exchangeProgramId,
  fetchExchangeConfig,
  fetchMarketsOfRound,
  fetchOrders,
  fetchRound,
  chainNow,
  getExchangeProgram,
  getRpc,
  getSolLamports,
  loadKeypair,
  ExchangeStateLoader,
  musdMint,
  readHeartbeat,
  sendExchangeTx,
  solToLamports,
  tokenBalance,
  ataOf,
  type RoundView,
} from "@metrex/server/exchange";
import { dataDir, loadCommittedDataset, settleRound } from "@metrex/server";
import { TradeIndex, connectionTradeSource } from "@metrex/server/exchange";
import { args, flagValue, log } from "./lib/common";
import { DEVNET_GENESIS, checkBotsQuoting, checkDepthGuarantee, isLoopback, type BotMakers } from "./lib/v2";

const LOCAL = args.includes("--local");
const FEATURED = 1;
const OTHER = 2;
const FRESH_MIN_S = 2n * 3600n;
/** How far back to look for the newest wildfire round (one Open round per hazard). */
const ROUNDS_BACK = 8n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const rpc = getRpc();
  const conn = rpc.connection;
  const p = getExchangeProgram(conn);
  let problems = 0;
  console.log(`prepare-demo-v2${LOCAL ? " (local validator)" : ""}`);

  // 1. Cluster, program, Config, collateral.
  log.step("cluster, program and Config");
  if (LOCAL) {
    if (!isLoopback(conn.rpcEndpoint)) throw new Error("--local requires a loopback RPC_URL");
  } else if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("RPC is not Solana Devnet");
  if (!(await conn.getAccountInfo(exchangeProgramId()))?.executable) throw new Error("v2 program is not deployed");
  const config = await fetchExchangeConfig(p, "confirmed");
  if (!config) throw new Error("Config missing: run setup-devnet-v2.ts first");
  if (!config.collateralMint.equals(musdMint())) throw new Error(`Config collateral ${config.collateralMint.toBase58()} is not the mUSD mint`);
  const controller = loadKeypair("controller");
  const oracle = loadKeypair("oracle");
  const keeper = loadKeypair("keeper");
  if (!config.roundController.equals(controller.publicKey) || !config.oracleAuthority.equals(oracle.publicKey)) throw new Error("local controller/oracle keys do not match Config");
  log.ok(`program ${p.programId.toBase58()}, Config ${config.address.toBase58()}, mUSD ${config.collateralMint.toBase58()}`);

  const bots: BotMakers = Object.fromEntries(
    DEMO_BOTS.map((b) => [loadKeypair(({ A: "botA", B: "botB", C: "botC" } as const)[b.name as "A" | "B" | "C"]).publicKey.toBase58(), b.name]),
  );

  // 2. Stale round: reuse only a fresh one (only bot activity, > 2 h left); otherwise settle it.
  log.step("latest wildfire round");
  let reuse: RoundView | null = null;
  let latest: RoundView | null = null;
  for (let id = config.nextRoundId - 1n; id >= 0n && id >= config.nextRoundId - ROUNDS_BACK; id--) {
    const r = await fetchRound(p, findRoundPda(p.programId, id)[0], "confirmed");
    if (r?.scenarioId === SCENARIO_PALISADES_2025) {
      latest = r;
      break;
    }
  }
  // The catalog wildfire market (real address, scripts/prepare-multiperil.ts) owns the wildfire
  // round now. Settling it here, or opening a second wildfire round, would break the
  // one-Open-round-per-hazard policy (docs/spec-multiperil.md §2.2).
  const catalogWildfire = catalogByProperty(7);
  if (latest && catalogWildfire && !args.includes("--legacy")) {
    const { market } = marketAddresses(p.programId, latest.address, catalogWildfire.propertyId);
    if (await conn.getAccountInfo(market)) {
      throw new Error(`round ${latest.roundId} is the catalog wildfire round; use scripts/prepare-multiperil.ts (or pass --legacy to settle it here)`);
    }
  }
  if (latest) {
    const now = await chainNow(conn, "confirmed");
    const markets = await fetchMarketsOfRound(p, latest.address);
    const unresolved = markets.filter((m) => m.outcome === "unresolved");
    if (latest.status === "open") {
      const idx = new TradeIndex(connectionTradeSource(() => conn, p.programId));
      await idx.refresh();
      const outsiders = new Set<string>();
      for (const m of markets) {
        for (const t of idx.trades(m.address.toBase58())) for (const w of [t.fill.buyer, t.fill.seller]) if (!bots[w]) outsiders.add(w);
        for (const o of await fetchOrders(p, { market: m.address })) if (!bots[o.maker]) outsiders.add(o.maker);
      }
      const fresh = outsiders.size === 0 && latest.tradingEndsAt - now > FRESH_MIN_S && markets.length >= 2;
      if (fresh && !args.includes("--new-round")) {
        reuse = latest;
        log.ok(`round ${latest.roundId} is fresh (bots only, ${(latest.tradingEndsAt - now) / 3600n} h left): reusing it`);
      } else {
        log.todo(`round ${latest.roundId} is stale (${outsiders.size} non-bot wallets, ${latest.tradingEndsAt - now} s left): close, resolve, sweep`);
      }
    }
    if (!reuse && (latest.status === "open" || unresolved.length)) {
      const steps = await settleRound(latest.address, {
        rpc,
        controller,
        oracle,
        keeper,
        log: (s) => (s.signature ? log.tx(`${s.step} ${s.target}${s.note ? ` (${s.note})` : ""}`, s.signature) : log.ok(`${s.step} ${s.target} ${s.note ?? ""}`)),
      });
      log.ok(`settled round ${latest.roundId} in ${steps.length} steps`);
    } else if (!reuse) log.ok(`round ${latest.roundId} is closed and settled`);
  } else log.ok("no earlier wildfire round");

  // 3. New round with the committed dataset hash, markets for properties 1 and 2.
  let round: RoundView;
  if (reuse) round = reuse;
  else {
    log.step("new round");
    const registry = JSON.parse(readFileSync(join(dataDir(), "scenarios.json"), "utf8")) as ScenarioRegistry;
    const scenario = registry["1"];
    if (!scenario) throw new Error("scenario 1 missing from data/scenarios.json");
    const fileHash = createHash("sha256").update(readFileSync(join(dataDir(), scenario.file))).digest("hex");
    if (fileHash !== scenario.sha256) throw new Error("data/ dataset does not match its committed hash in scenarios.json");
    const fresh = await fetchExchangeConfig(p, "confirmed");
    if (!fresh) throw new Error("Config missing");
    const now = await chainNow(conn, "confirmed");
    const hours = BigInt(flagValue("--hours") ?? "24");
    const roundId = fresh.nextRoundId;
    const ix = await createRoundIx(p, {
      roundController: controller.publicKey,
      roundId,
      previousRound: fresh.latestRound.equals(PublicKey.default) ? null : fresh.latestRound,
      scenarioId: scenario.scenarioId,
      datasetSha256: Array.from(Buffer.from(scenario.sha256, "hex")),
      label: encodeLabel(`Palisades replay #${roundId}`),
      tradingEndsAt: now + hours * 3600n,
    });
    log.tx(`create_round #${roundId}`, await sendExchangeTx(conn, [ix], [controller], { commitment: "finalized" }));
    const r = await fetchRound(p, findRoundPda(p.programId, roundId)[0], "finalized");
    if (!r) throw new Error("round not found after create");
    round = r;
  }
  const marketsStart = Date.now();
  for (const id of [FEATURED, OTHER]) {
    const { market } = marketAddresses(p.programId, round.address, id);
    if (await conn.getAccountInfo(market)) {
      log.ok(`market property ${id} ${market.toBase58()}`);
      continue;
    }
    const ix = await createMarketIx(p, { roundController: controller.publicKey, round: round.address, propertyId: id, collateralMint: config.collateralMint });
    log.tx(`create_market property ${id}`, await sendExchangeTx(conn, [ix], [controller]));
  }

  // 4. Balances (top-ups come from fund-bots.ts / fund-wallet.ts).
  log.step("balances");
  const need: [string, PublicKey, bigint, bigint][] = [
    ...Object.entries(bots).map(([k, n]) => [`bot ${n}`, new PublicKey(k), solToLamports("0.05"), 10_000n * MUSD_UNIT] as [string, PublicKey, bigint, bigint]),
    ["keeper", keeper.publicKey, solToLamports("0.02"), 0n],
    ["presenter", loadKeypair("homeownerDemo").publicKey, solToLamports("0.02"), 20n * MUSD_UNIT],
  ];
  for (const [name, pk, sol, mUsd] of need) {
    const [s, u] = [await getSolLamports(conn, pk), await tokenBalance(conn, ataOf(config.collateralMint, pk))];
    if (s < sol || u < mUsd) {
      log.fail(`${name} ${pk.toBase58()} is short (SOL ${s}, mUSD ${u}); run scripts/fund-bots.ts`);
      problems++;
    } else log.ok(`${name} funded`);
  }

  // 5. Bots quoting, depth guarantee, heartbeats, oracle dataset (no evaluation).
  log.step("bots, ladder, heartbeats, oracle dataset");
  const waitS = args.includes("--no-wait") ? 0 : Number(flagValue("--wait") ?? 60);
  const markets = await fetchMarketsOfRound(p, round.address);
  // One cached loader for the polling (no getProgramAccounts scan per poll; see ExchangeStateLoader).
  const loader = new ExchangeStateLoader();
  for (const m of markets) {
    let bad: string[] = ["not checked"];
    let chainS = "";
    const deadline = Date.now() + waitS * 1000;
    do {
      const state = await loader.load(conn, { roundsBack: Number(config.nextRoundId - round.roundId) + 1 });
      const snap = state?.snapshots.find((s) => s.market.address.equals(m.address));
      if (snap) bad = [...checkBotsQuoting(snap.book, bots), ...(m.propertyId === FEATURED ? checkDepthGuarantee(snap.book, bots, catalogByProperty(FEATURED)?.ladder ?? DEMO_BOTS) : [])];
      if (snap && !bad.length) {
        // On-chain measure: the newest resting bot quote's created_at against the market's (Clock sysvar seconds).
        const newest = snap.orders.filter((o) => o.maker in bots).reduce((t, o) => (o.createdAt > t ? o.createdAt : t), 0n);
        chainS = `, last bot quote ${newest - snap.market.createdAt} s after the market on the chain clock`;
      }
      if (!bad.length || Date.now() > deadline) break;
      await sleep(500);
    } while (true);
    if (bad.length) {
      for (const b of bad) log.fail(`property ${m.propertyId}: ${b}`);
      problems++;
    } else log.ok(`property ${m.propertyId}: three bots quote both books, no crosses${m.propertyId === FEATURED ? ", catalog ladder exact" : ""} (${((Date.now() - marketsStart) / 1000).toFixed(1)} s after this script began creating markets${chainS})`);
  }
  for (const hb of ["bots", "keeper"] as const) {
    const r = readHeartbeat(hb);
    if (r.alive) log.ok(`${hb} heartbeat ${r.ageMs} ms old`);
    else {
      log.fail(`${hb} heartbeat missing or stale`);
      problems++;
    }
  }
  loadCommittedDataset(round); // throws on a hash mismatch; evaluates nothing
  log.ok(`oracle dataset matches round.dataset_sha256 ${Buffer.from(round.datasetSha256).toString("hex").slice(0, 16)}…`);

  // 6. URLs and checklist.
  log.step("demo");
  const app = process.env.METREX_APP_ORIGIN ?? "http://localhost:3000";
  const featured = markets.find((m) => m.propertyId === FEATURED);
  console.log(`  round     #${round.roundId} ${round.address.toBase58()} (${round.label})`);
  console.log(`  featured  ${app}/market/${featured?.address.toBase58()}  (Home #1042)`);
  console.log(`  operator  ${app}/operator`);
  console.log("  checklist: Phantom funded and connected · bots and keeper running · nothing closed in advance");
  if (problems) {
    console.log(`\nIncomplete: ${problems} problem(s) above.`);
    process.exit(1);
  }
  console.log("\nReady.");
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(`prepare-demo-v2 failed: ${(e as Error).message}`);
  process.exit(1);
});
