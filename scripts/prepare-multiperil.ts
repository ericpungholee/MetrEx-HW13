// Prepare the catalog rounds and validate their pinned datasets. Use --prepare-only before
// starting workers, or run without it to also check the live executable books and heartbeats.
// Startup reuses open rounds. --advance-expired handles elapsed deadlines, --replace-retired
// rotates a superseded property, and --new-round explicitly rotates selected hazards.
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
  ataOf,
  chainNow,
  createMarketIx,
  createRoundIx,
  exchangeProgramId,
  fetchExchangeConfig,
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
  const hazard = flagValue("--hazard");
  const targets = CATALOG.filter((c) => !hazard || c.hazard === hazard);
  if (!targets.length) throw new Error("Unknown --hazard");
  const hours = BigInt(flagValue("--hours") ?? "24");
  if (hours < 1n || hours > 720n) throw new Error("--hours must be between 1 and 720");
  const loader = new ExchangeStateLoader();

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

  // Never rotate a live replay merely because someone traded or a process restarted.
  log.step("round discovery");
  const discovered = await loader.load(conn);
  if (!discovered) throw new Error("Exchange Config disappeared during discovery");
  const rounds = new Map<number, RoundView>();
  for (const c of targets) {
    log.step(`${c.hazard} round (scenario ${c.scenarioId})`);
    const scenario = registry[String(c.scenarioId)]!;
    const fileHash = createHash("sha256").update(readFileSync(join(dataDir(), scenario.file))).digest("hex");
    if (fileHash !== scenario.sha256) throw new Error(`data/${scenario.file} does not match scenarios.json`);
    const list = discovered.rounds.filter((r) => r.scenarioId === c.scenarioId && r.status === "open");
    if (list.length > 1) throw new Error(`Multiple open rounds for ${c.hazard}. Resolve the operator policy conflict explicitly.`);
    const latest = list[0];
    let reuse: RoundView | null = null;
    if (latest) {
      const markets = discovered.snapshots.filter((s) => s.round.address.equals(latest.address));
      const retired = markets.length > 0 && !markets.some((s) => s.market.propertyId === c.propertyId);
      const expired = latest.tradingEndsAt <= discovered.now;
      const sameHash = Buffer.from(latest.datasetSha256).toString("hex") === scenario.sha256;
      const rotate = args.includes("--new-round") || (retired && args.includes("--replace-retired")) ||
        (expired && args.includes("--advance-expired"));
      if (!rotate) {
        if (retired || expired || !sameHash) {
          throw new Error(`Round ${latest.roundId} needs explicit rotation (--replace-retired, --advance-expired or --new-round)`);
        }
        reuse = latest;
        log.ok(`reusing open round ${latest.roundId}`);
      } else if (DRY_RUN) log.todo(`settle round ${latest.roundId}`);
      else {
        await settleRound(latest.address, {
          rpc, controller, oracle, keeper,
          log: (s) => s.signature ? log.tx(`${s.step} ${s.target}`, s.signature) : log.ok(`${s.step} ${s.target} ${s.note ?? ""}`),
        });
      }
    }

    let round: RoundView | null = reuse;
    if (!round) {
      if (DRY_RUN) {
        log.todo(`create_round(scenario ${c.scenarioId}, "${c.roundLabel}", dataset ${scenario.sha256.slice(0, 16)}…)`);
        continue;
      }
      const fresh = await fetchExchangeConfig(p, "confirmed");
      if (!fresh) throw new Error("Config missing");
      const now = await chainNow(conn, "confirmed");
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

  if (args.includes("--prepare-only")) {
    if (problems > 0) process.exitCode = 1;
    return;
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
  for (const c of targets) {
    const round = rounds.get(c.propertyId);
    if (!round) continue;
    const { market } = marketAddresses(p.programId, round.address, c.propertyId);
    let bad: string[] = ["not checked"];
    const deadline = Date.now() + waitS * 1000;
    do {
      const state = await loader.load(conn);
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
