// prepare-multiperil.ts (docs/spec-multiperil.md §2.2, §3, §6): register the four catalog properties
// (real OpenStreetMap addresses, data/market-properties.json), then keep exactly one Open round per
// hazard with that hazard's catalog market. Idempotent. Never evaluates or prints a settlement
// outcome before finalized resolution.
//   pnpm tsx scripts/prepare-multiperil.ts [--local] [--hours 24] [--wait 60] [--no-wait] [--new-round] [--dry-run]
// Run setup-devnet-v2.ts and fund-bots.ts first, then start the v2 bots and keeper. This script owns
// all four hazards, wildfire included; prepare-demo-v2.ts is the legacy fictional-home demo.
//
// One Open round per hazard is operator policy (§2.2), not a program guarantee: this script
// settles a stale round of a hazard before it opens that hazard's next round.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import {
  CATALOG,
  BPS_DENOMINATOR,
  MUSD_UNIT,
  PAYOUT_PER_SHARE,
  findRoundPda,
  marketAddresses,
  type CatalogMarket,
} from "@metrex/exchange";
import { encodeLabel, type ScenarioRegistry } from "@metrex/shared";
import {
  ExchangeStateLoader,
  TradeIndex,
  ataOf,
  chainNow,
  connectionTradeSource,
  createMarketIx,
  createRoundIx,
  exchangeProgramId,
  fetchExchangeConfig,
  fetchMarketsOfRound,
  fetchOrders,
  fetchProperty,
  fetchRound,
  getExchangeProgram,
  getRpc,
  loadKeypair,
  musdMint,
  registerExchangePropertyIx,
  sendExchangeTx,
  tokenBalance,
  type RoundView,
} from "@metrex/server/exchange";
import { dataDir, loadCommittedDataset, settleRound } from "@metrex/server";
import { args, DRY_RUN, flagValue, log } from "./lib/common";
import { DEVNET_GENESIS, checkBotsQuoting, checkDepthGuarantee, isLoopback, type BotMakers } from "./lib/v2";

const LOCAL = args.includes("--local");
const FRESH_MIN_S = 2n * 3600n;
const ROUNDS_BACK = 8n;
const POINT_SCENARIOS = new Set([2, 3]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface HazardPropertyRow {
  property_id: number;
  label: string;
  lat_e6: number;
  lon_e6: number;
  scenario_id: number;
  trigger_distance_m: number;
}

/** Property rows from data/market-properties.json, checked against the catalog and the trigger convention (§3). */
function hazardProperties(registry: ScenarioRegistry): Map<number, HazardPropertyRow> {
  const rows = JSON.parse(readFileSync(join(dataDir(), "market-properties.json"), "utf8")) as HazardPropertyRow[];
  const out = new Map<number, HazardPropertyRow>();
  for (const r of rows) {
    const c = CATALOG.find((x) => x.propertyId === r.property_id);
    if (!c) throw new Error(`hazard property ${r.property_id} is not in the catalog`);
    if (c.scenarioId !== r.scenario_id) throw new Error(`property ${r.property_id}: scenario ${r.scenario_id} ≠ catalog ${c.scenarioId}`);
    if (c.address !== r.label) throw new Error(`property ${r.property_id}: label "${r.label}" ≠ catalog address "${c.address}"`);
    if (!registry[String(r.scenario_id)]) throw new Error(`scenario ${r.scenario_id} missing from data/scenarios.json`);
    const point = POINT_SCENARIOS.has(r.scenario_id);
    if (point ? r.trigger_distance_m !== 0 : r.trigger_distance_m <= 0) throw new Error(`property ${r.property_id}: trigger distance contradicts the scenario's method`);
    encodeLabel(r.label); // throws past 32 bytes
    out.set(r.property_id, r);
  }
  return out;
}

/** mUSD a bot commits to one catalog market at zero inventory: both bids plus one split (§6). */
function botNeed(c: CatalogMarket, bot: string): bigint {
  const b = c.ladder.find((x) => x.name === bot);
  if (!b) return 0n;
  const yesBid = BigInt(b.refBps - b.halfSpreadBps);
  const noBid = BigInt(BPS_DENOMINATOR - (b.refBps + b.halfSpreadBps));
  return b.topSize * (yesBid + noBid) * 100n + c.splitPairs * PAYOUT_PER_SHARE;
}

async function main(): Promise<void> {
  const rpc = getRpc();
  const conn = rpc.connection;
  const p = getExchangeProgram(conn);
  let problems = 0;
  console.log(`prepare-multiperil${DRY_RUN ? " (dry run)" : ""}${LOCAL ? " (local validator)" : ""}`);

  log.step("cluster, program and Config");
  if (LOCAL) {
    if (!isLoopback(conn.rpcEndpoint)) throw new Error("--local requires a loopback RPC_URL");
  } else if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("RPC is not Solana Devnet");
  if (!(await conn.getAccountInfo(exchangeProgramId()))?.executable) throw new Error("v2 program is not deployed");
  const config = await fetchExchangeConfig(p, "confirmed");
  if (!config) throw new Error("Config missing: run setup-devnet-v2.ts first");
  if (!config.collateralMint.equals(musdMint())) throw new Error("Config collateral is not the mUSD mint");
  const admin = loadKeypair("admin");
  const controller = loadKeypair("controller");
  const oracle = loadKeypair("oracle");
  const keeper = loadKeypair("keeper");
  if (!config.admin.equals(admin.publicKey) || !config.roundController.equals(controller.publicKey) || !config.oracleAuthority.equals(oracle.publicKey)) {
    throw new Error("local admin/controller/oracle keys do not match Config");
  }
  log.ok(`program ${p.programId.toBase58()}, Config ${config.address.toBase58()}`);

  const registry = JSON.parse(readFileSync(join(dataDir(), "scenarios.json"), "utf8")) as ScenarioRegistry;
  const props = hazardProperties(registry);
  const bots: BotMakers = Object.fromEntries((["A", "B", "C"] as const).map((n) => [loadKeypair(`bot${n}`).publicKey.toBase58(), n]));
  const targets = CATALOG;

  // 1. Catalog properties (admin). Registered data never changes; a mismatch is a failure, never an overwrite.
  log.step("catalog properties (data/market-properties.json)");
  for (const c of targets) {
    const r = props.get(c.propertyId);
    if (!r) throw new Error(`property ${c.propertyId} missing from data/market-properties.json`);
    const existing = await fetchProperty(p, r.property_id);
    if (existing) {
      const same =
        existing.latE6 === r.lat_e6 && existing.lonE6 === r.lon_e6 && existing.scenarioId === r.scenario_id && existing.triggerDistanceM === r.trigger_distance_m && existing.label === r.label;
      if (same) log.ok(`property ${r.property_id} "${r.label}"`);
      else {
        log.fail(`property ${r.property_id} is registered with different data`);
        problems++;
      }
    } else if (DRY_RUN) log.todo(`register_property(${r.property_id}, "${r.label}", scenario ${r.scenario_id})`);
    else {
      const ix = await registerExchangePropertyIx(p, admin.publicKey, {
        propertyId: r.property_id,
        label: encodeLabel(r.label),
        latE6: r.lat_e6,
        lonE6: r.lon_e6,
        scenarioId: r.scenario_id,
        triggerDistanceM: r.trigger_distance_m,
      });
      log.tx(`register_property ${r.property_id}`, await sendExchangeTx(conn, [ix], [admin], { commitment: "finalized" }));
    }
  }

  // 2. One Open round per hazard: reuse a fresh one, settle a stale one, open a new one.
  const rounds = new Map<number, RoundView>();
  const recent: RoundView[] = [];
  for (let id = config.nextRoundId - 1n; id >= 0n && id >= config.nextRoundId - ROUNDS_BACK; id--) {
    const r = await fetchRound(p, findRoundPda(p.programId, id)[0], "confirmed");
    if (r) recent.push(r);
  }
  const idx = new TradeIndex(connectionTradeSource(() => conn, p.programId));
  await idx.refresh();
  for (const c of targets) {
    log.step(`${c.hazard} round (scenario ${c.scenarioId})`);
    const scenario = registry[String(c.scenarioId)]!;
    const fileHash = createHash("sha256").update(readFileSync(join(dataDir(), scenario.file))).digest("hex");
    if (fileHash !== scenario.sha256) throw new Error(`data/${scenario.file} does not match its committed hash in scenarios.json`);
    const latest = recent.find((r) => r.scenarioId === c.scenarioId) ?? null;
    let reuse: RoundView | null = null;
    if (latest) {
      const now = await chainNow(conn, "confirmed");
      const markets = await fetchMarketsOfRound(p, latest.address);
      if (latest.status === "open") {
        const outsiders = new Set<string>();
        for (const m of markets) {
          for (const t of idx.trades(m.address.toBase58())) for (const w of [t.fill.buyer, t.fill.seller]) if (!bots[w]) outsiders.add(w);
          for (const o of await fetchOrders(p, { market: m.address })) if (!bots[o.maker]) outsiders.add(o.maker);
        }
        const sameHash = Buffer.from(latest.datasetSha256).toString("hex") === scenario.sha256;
        const fresh = outsiders.size === 0 && sameHash && latest.tradingEndsAt - now > FRESH_MIN_S;
        if (fresh && !args.includes("--new-round")) {
          reuse = latest;
          log.ok(`round ${latest.roundId} is fresh (bots only, ${(latest.tradingEndsAt - now) / 3600n} h left): reusing it`);
        } else log.todo(`round ${latest.roundId} is stale (${outsiders.size} non-bot wallets, ${latest.tradingEndsAt - now} s left): close, resolve, sweep`);
      }
      if (!reuse && (latest.status === "open" || markets.some((m) => m.outcome === "unresolved"))) {
        if (DRY_RUN) log.todo(`settle round ${latest.roundId}`);
        else {
          const steps = await settleRound(latest.address, {
            rpc,
            controller,
            oracle,
            keeper,
            log: (s) => (s.signature ? log.tx(`${s.step} ${s.target}${s.note ? ` (${s.note})` : ""}`, s.signature) : log.ok(`${s.step} ${s.target} ${s.note ?? ""}`)),
          });
          log.ok(`settled round ${latest.roundId} in ${steps.length} steps`);
        }
      } else if (!reuse) log.ok(`round ${latest.roundId} is closed and settled`);
    } else log.ok("no earlier round of this hazard");

    let round: RoundView | null = reuse;
    if (!round) {
      if (DRY_RUN) {
        log.todo(`create_round(scenario ${c.scenarioId}, "${c.roundLabel}", dataset ${scenario.sha256.slice(0, 16)}…)`);
        continue;
      }
      const fresh = await fetchExchangeConfig(p, "confirmed");
      if (!fresh) throw new Error("Config missing");
      const now = await chainNow(conn, "confirmed");
      const hours = BigInt(flagValue("--hours") ?? "24");
      const roundId = fresh.nextRoundId;
      const ix = await createRoundIx(p, {
        roundController: controller.publicKey,
        roundId,
        previousRound: fresh.latestRound.equals(PublicKey.default) ? null : fresh.latestRound,
        scenarioId: c.scenarioId,
        datasetSha256: Array.from(Buffer.from(scenario.sha256, "hex")),
        label: encodeLabel(c.roundLabel),
        tradingEndsAt: now + hours * 3600n,
      });
      log.tx(`create_round #${roundId} (${c.roundLabel})`, await sendExchangeTx(conn, [ix], [controller], { commitment: "finalized" }));
      round = await fetchRound(p, findRoundPda(p.programId, roundId)[0], "finalized");
      if (!round) throw new Error("round not found after create");
    }
    rounds.set(c.propertyId, round);
    const { market } = marketAddresses(p.programId, round.address, c.propertyId);
    if (await conn.getAccountInfo(market)) log.ok(`market property ${c.propertyId} ${market.toBase58()}`);
    else if (DRY_RUN) log.todo(`create_market property ${c.propertyId}`);
    else {
      const ix = await createMarketIx(p, { roundController: controller.publicKey, round: round.address, propertyId: c.propertyId, collateralMint: config.collateralMint });
      log.tx(`create_market property ${c.propertyId}`, await sendExchangeTx(conn, [ix], [controller], { commitment: "finalized" }));
    }
    loadCommittedDataset(round); // throws on a hash mismatch; evaluates nothing
    log.ok(`oracle dataset matches round.dataset_sha256 ${scenario.sha256.slice(0, 16)}…`);
  }

  // 3. Bot balances: what every catalog market commits at zero inventory (fund-bots.ts tops up).
  log.step("bot balances");
  for (const [pk, name] of Object.entries(bots)) {
    const need = CATALOG.reduce((a, c) => a + botNeed(c, name), 0n);
    const have = await tokenBalance(conn, ataOf(config.collateralMint, new PublicKey(pk)));
    const msg = `bot ${name}: ${have / MUSD_UNIT} mUSD free; the four catalog markets commit ${need / MUSD_UNIT} mUSD at zero inventory`;
    // Free balance excludes what is already escrowed, so a low reading on a quoting bot is expected.
    if (have < need) log.warn(`${msg} (fine if it is already quoting; otherwise run scripts/fund-bots.ts)`);
    else log.ok(msg);
  }

  // 4. Bots quoting each new market with that market's exact ladder.
  log.step("bots and ladders");
  const waitS = args.includes("--no-wait") || DRY_RUN ? 0 : Number(flagValue("--wait") ?? 60);
  const loader = new ExchangeStateLoader();
  for (const c of targets) {
    const round = rounds.get(c.propertyId);
    if (!round) continue;
    const { market } = marketAddresses(p.programId, round.address, c.propertyId);
    let bad: string[] = ["not checked"];
    const deadline = Date.now() + waitS * 1000;
    do {
      const state = await loader.load(conn, { roundsBack: Number(ROUNDS_BACK) });
      const snap = state?.snapshots.find((s) => s.market.address.equals(market));
      if (snap) bad = [...checkBotsQuoting(snap.book, bots), ...checkDepthGuarantee(snap.book, bots, c.ladder)];
      if (!bad.length || Date.now() > deadline) break;
      await sleep(1000);
    } while (true);
    if (bad.length) {
      for (const b of bad) log.fail(`property ${c.propertyId} (${c.hazard}): ${b}`);
      problems++;
    } else log.ok(`property ${c.propertyId} (${c.hazard}): three bots quote both books at the catalog ladder, no crosses`);
  }

  log.step("markets");
  const app = process.env.METREX_APP_ORIGIN ?? "http://localhost:3000";
  for (const c of targets) {
    const round = rounds.get(c.propertyId);
    if (!round) continue;
    const { market } = marketAddresses(p.programId, round.address, c.propertyId);
    console.log(`  ${c.hazard.padEnd(10)} round #${round.roundId} (${round.label})  ${app}/market/${market.toBase58()}`);
  }
  if (problems) {
    console.log(`\nIncomplete: ${problems} problem(s) above.`);
    process.exit(1);
  }
  console.log("\nReady.");
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(`prepare-multiperil failed: ${(e as Error).message}`);
  process.exit(1);
});
