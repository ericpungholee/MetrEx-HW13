// Demo lifecycle primitives (docs/spec-simulation.md §6, §7, §9). Server-only: uses the controller and
// oracle keys and the private settlement data. The oracle alone decides every outcome.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PublicKey } from "@solana/web3.js";
import { CATALOG, LISTINGS, catalogByScenario, findRoundPda, marketAddresses, type CatalogMarket } from "@metrex/exchange";
import { encodeLabel, type ScenarioRegistry } from "@metrex/shared";
import { chainNow, fetchExchangeConfig, fetchExchangeMarket, fetchMarketsOfRound, fetchProperty, fetchRound, type MarketView, type RoundView } from "../exchange/accounts";
import { ExchangeStateLoader } from "../exchange/book";
import { closeRoundIx, createMarketIx, createRoundIx, registerExchangePropertyIx, resolveExchangeMarketIx } from "../exchange/ix";
import { homeById } from "./homes";
import { getExchangeProgram } from "../exchange/program";
import { sendExchangeTx } from "../exchange";
import { dataDir, loadKeypair } from "../env";
import { buildExchangeEvidence, loadCommittedDataset } from "../oracle/exchange";
import { getRpc } from "../rpc";
import { conflict, KeyedLock, notFound } from "../routes/errors";

const createLock = new KeyedLock();

/** Markets of a round: catalog PDAs first (no program scan), the scan as a fallback. */
export async function roundMarkets(round: RoundView, commitment: "confirmed" | "finalized" = "confirmed"): Promise<MarketView[]> {
  const rpc = getRpc();
  const entry = catalogByScenario(round.scenarioId);
  if (entry && round.marketCount === 1) {
    const { market } = marketAddresses(getExchangeProgram(rpc.connection).programId, round.address, entry.propertyId);
    const m = await rpc.run((c) => fetchExchangeMarket(getExchangeProgram(c), market, commitment));
    if (m) return [m];
  }
  return rpc.run((c) => fetchMarketsOfRound(getExchangeProgram(c), round.address));
}

/**
 * Fast path to redeemable: `close_round` and the oracle's `resolve_market` for every unresolved
 * market in one transaction, confirmed. Evidence is built first from the dataset whose hash the
 * round committed (a mismatch or missing coverage throws, and nothing is sent). The evidence never
 * depends on `closed_at`, so it is identical to what the step-by-step path would publish.
 */
export async function closeAndResolve(roundAddress: PublicKey): Promise<{ signature: string | null; resolved: number }> {
  const rpc = getRpc();
  const round = await rpc.run((c) => fetchRound(getExchangeProgram(c), roundAddress, "confirmed"));
  if (!round) throw notFound("Round not found");
  if (round.status !== "open") return { signature: null, resolved: 0 };
  const p = getExchangeProgram(rpc.connection);
  const controller = loadKeypair("controller");
  const oracle = loadKeypair("oracle");
  const config = await rpc.run((c) => fetchExchangeConfig(getExchangeProgram(c), "confirmed"));
  if (!config || !config.oracleAuthority.equals(oracle.publicKey) || !config.roundController.equals(controller.publicKey)) {
    throw conflict("Local controller or oracle key does not match Config");
  }
  const ixs = [await closeRoundIx(p, controller.publicKey, round.address)];
  let resolved = 0;
  for (const m of await roundMarkets(round)) {
    if (m.outcome !== "unresolved") continue;
    const built = buildExchangeEvidence(m, round, p.programId);
    ixs.push(await resolveExchangeMarketIx(p, {
      oracleAuthority: oracle.publicKey, round: round.address, market: m.address,
      triggered: built.record.triggered, evidenceHash: built.hashBytes,
    }));
    resolved++;
  }
  const signature = await sendExchangeTx(rpc.connection, ixs, [controller, oracle], { commitment: "confirmed" });
  return { signature, resolved };
}

/** Waits until the finalized round is Closed (settleRound reads finalized state). */
export async function waitFinalizedClosed(roundAddress: PublicKey, timeoutMs = 90_000): Promise<RoundView> {
  const rpc = getRpc();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await rpc.run((c) => fetchRound(getExchangeProgram(c), roundAddress, "finalized")).catch(() => null);
    if (r && r.status === "closed") return r;
    await delay(1_500);
  }
  throw conflict("Closure has not finalized yet; retry");
}

export interface OpenedRound {
  round: RoundView;
  market: PublicKey;
  signatures: string[];
  created: boolean;
}

/**
 * Opens the next round for a catalog market and its one market (spec-multiperil §2.2: one Open
 * round per hazard). Idempotent: when a newer round of the scenario than `after` already exists it is
 * adopted (and its market created if missing), so a retried reset never opens two.
 */
export async function openCatalogRound(entry: CatalogMarket, durationS: bigint, after: bigint | null): Promise<OpenedRound> {
  return createLock.with("create-round", async () => {
    const rpc = getRpc();
    const p = getExchangeProgram(rpc.connection);
    const registry = JSON.parse(readFileSync(join(dataDir(), "scenarios.json"), "utf8")) as ScenarioRegistry;
    const scenario = registry[String(entry.scenarioId)];
    if (!scenario) throw conflict(`Scenario ${entry.scenarioId} missing from data/scenarios.json`);
    const fileHash = createHash("sha256").update(readFileSync(join(dataDir(), scenario.file))).digest("hex");
    if (fileHash !== scenario.sha256) throw conflict(`data/${scenario.file} does not match scenarios.json`);
    const controller = loadKeypair("controller");
    const state = await rpc.run((c) => new ExchangeStateLoader().load(c, { roundsBack: 16, commitment: "finalized" }));
    if (!state) throw conflict("Config missing");
    const same = state.rounds.filter((r) => r.scenarioId === entry.scenarioId);
    const adopt = same.filter((r) => after === null || r.roundId > after).at(-1);
    const signatures: string[] = [];
    let round: RoundView | null = adopt ?? null;
    let created = false;
    if (!round) {
      const open = same.filter((r) => r.status === "open");
      if (open.length) throw conflict(`Round ${open[0]!.roundId} of this hazard is still open; settle it first`);
      const config = await rpc.run((c) => fetchExchangeConfig(getExchangeProgram(c), "finalized"));
      if (!config) throw conflict("Config missing");
      const now = await rpc.run((c) => chainNow(c, "finalized"));
      const ix = await createRoundIx(p, {
        roundController: controller.publicKey,
        roundId: config.nextRoundId,
        previousRound: config.latestRound.equals(PublicKey.default) ? null : config.latestRound,
        scenarioId: entry.scenarioId,
        datasetSha256: Array.from(Buffer.from(scenario.sha256, "hex")),
        label: encodeLabel(entry.roundLabel),
        tradingEndsAt: now + durationS,
      });
      signatures.push(await sendExchangeTx(rpc.connection, [ix], [controller], { commitment: "finalized" }));
      round = await rpc.run((c) => fetchRound(getExchangeProgram(c), findRoundPda(p.programId, config.nextRoundId)[0], "finalized"));
      if (!round) throw conflict("Round not found after create; retry");
      created = true;
    }
    const { market } = marketAddresses(p.programId, round.address, entry.propertyId);
    if (!(await rpc.run((c) => c.getAccountInfo(market, "finalized")))) {
      if (round.status !== "open") throw conflict(`Round ${round.roundId} closed before its market was created`);
      const config = await rpc.run((c) => fetchExchangeConfig(getExchangeProgram(c), "finalized"));
      const ix = await createMarketIx(p, { roundController: controller.publicKey, round: round.address, propertyId: entry.propertyId, collateralMint: config!.collateralMint });
      signatures.push(await sendExchangeTx(rpc.connection, [ix], [controller], { commitment: "finalized" }));
    }
    loadCommittedDataset(round); // the oracle data must match the committed hash
    return { round, market, signatures, created };
  });
}

/** Newest round of each catalog scenario among the last rounds (the featured markets). */
export async function featuredRounds(): Promise<Map<number, RoundView>> {
  const state = await getRpc().run((c) => new ExchangeStateLoader().load(c, { roundsBack: 16, commitment: "confirmed" }));
  const out = new Map<number, RoundView>();
  for (const c of CATALOG) {
    const r = state?.snapshots.filter((s) => s.market.propertyId === c.propertyId && s.round.scenarioId === c.scenarioId).at(-1)?.round;
    if (r) out.set(c.scenarioId, r);
  }
  return out;
}

export interface ListedMarket {
  round: PublicKey;
  market: PublicKey;
  signature: string | null;
}

/**
 * New market (docs/spec-multiperil.md §7.7): the round controller lists a listing property, or a
 * homeowner's house from the pinned home pool, in its hazard's current catalog round. A home is
 * registered by the admin in the same transaction the first time it is listed. The round must be
 * open with time left, and the program still enforces one market per (round, property).
 * Idempotent: an existing market is returned without a transaction.
 */
export async function listMarket(propertyId: number, currentRound: (scenarioId: number) => Promise<PublicKey | null>): Promise<ListedMarket> {
  const listing = LISTINGS.find((l) => l.propertyId === propertyId);
  const home = listing ? undefined : homeById(propertyId);
  if (!listing && !home) throw notFound("Not an available address");
  const scenarioId = listing?.scenarioId ?? home!.scenario_id;
  const label = listing?.address ?? home!.label;
  return createLock.with(`list-${propertyId}`, async () => {
    const rpc = getRpc();
    const p = getExchangeProgram(rpc.connection);
    const roundAddress = await currentRound(scenarioId);
    if (!roundAddress) throw conflict("This hazard has no round");
    const round = await rpc.run((c) => fetchRound(getExchangeProgram(c), roundAddress, "confirmed"));
    if (!round) throw notFound("Round not found");
    const { market } = marketAddresses(p.programId, round.address, propertyId);
    if (await rpc.run((c) => c.getAccountInfo(market, "confirmed"))) return { round: round.address, market, signature: null };
    const now = await rpc.run((c) => chainNow(c, "confirmed"));
    if (round.status !== "open" || now >= round.tradingEndsAt) throw conflict("Trading has ended for this hazard");
    const controller = loadKeypair("controller");
    const config = await rpc.run((c) => fetchExchangeConfig(getExchangeProgram(c), "confirmed"));
    if (!config || !config.roundController.equals(controller.publicKey)) throw conflict("Local controller key does not match Config");
    loadCommittedDataset(round); // the oracle must hold the committed dataset before trading starts
    const ixs = [];
    const signers = [controller];
    const property = await rpc.run((c) => fetchProperty(getExchangeProgram(c), propertyId));
    if (property) {
      const same = property.scenarioId === scenarioId && property.label === label &&
        (!home || (property.latE6 === home.lat_e6 && property.lonE6 === home.lon_e6 && property.triggerDistanceM === home.trigger_distance_m));
      if (!same) throw conflict("Property is registered with different data");
    } else if (home) {
      const admin = loadKeypair("admin");
      if (!config.admin.equals(admin.publicKey)) throw conflict("Local admin key does not match Config");
      ixs.push(await registerExchangePropertyIx(p, admin.publicKey, {
        propertyId, label: encodeLabel(home.label), latE6: home.lat_e6, lonE6: home.lon_e6,
        scenarioId: home.scenario_id, triggerDistanceM: home.trigger_distance_m,
      }));
      signers.push(admin);
    } else {
      throw conflict("Property is not registered for this hazard");
    }
    ixs.push(await createMarketIx(p, { roundController: controller.publicKey, round: round.address, propertyId, collateralMint: config.collateralMint }));
    const signature = await sendExchangeTx(rpc.connection, ixs, signers, { commitment: "confirmed" });
    return { round: round.address, market, signature };
  });
}
