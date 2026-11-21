// v2 oracle (spec-v2 §9.3, §9.5): on-chain Round gate, dataset hash against `round.dataset_sha256`,
// evidence v2, finalized-only publication. Idempotent: an already resolved market is verified, not
// resolved again. The v1 oracle (resolve.ts) is unchanged and still serves the v1 fallback.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalize, buildEvidenceV2, type BuiltEvidenceV2, type EvidenceRecordV2 } from "@metrex/geo";
import { loadScenarioGeometry, loadScenarioRegistry } from "@metrex/geo/node";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { getScenario } from "@metrex/shared";
import { oracleDataDir, loadKeypair } from "../env";
import { explorerTx } from "../explorer";
import { getRpc, type RpcPool } from "../rpc";
import { badRequest, conflict, KeyedLock, notFound, unavailable } from "../routes/errors";
import {
  chainNow,
  fetchExchangeConfig,
  fetchExchangeMarket,
  fetchRound,
  type ConfigView,
  type MarketView,
  type RoundView,
} from "../exchange/accounts";
import { expireMarketIx, resolveExchangeMarketIx } from "../exchange/ix";
import { getExchangeProgram } from "../exchange/program";
import { sendExchangeTx } from "../exchange";
import { readEvidenceBytes, sha256Hex, writeEvidence } from "./evidence-store";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** `T = closed_at + resolution_timeout_s` (§6.6). */
export const resolutionDeadline = (round: RoundView, config: Pick<ConfigView, "resolutionTimeoutS">): bigint =>
  round.closedAt + config.resolutionTimeoutS;

export type GateResult = "resolve" | "already_resolved";

/** §9.3 step 1. Throws with a plain reason when the oracle must not act. */
export function assertRoundGate(round: RoundView, market: MarketView, config: ConfigView, now: bigint): GateResult {
  if (!market.round.equals(round.address)) throw badRequest("Market does not belong to this round");
  if (market.outcome === "yes" || market.outcome === "no") return "already_resolved";
  if (market.outcome === "invalid") throw conflict("Market settled Invalid; there is nothing for the oracle to resolve");
  if (round.status !== "closed") throw conflict("Round is still Open; close it before resolving");
  if (now >= resolutionDeadline(round, config)) {
    throw conflict("The oracle resolution window has closed; anyone can expire the market to Invalid");
  }
  return "resolve";
}

/** §9.3 step 2. Refuses a dataset whose SHA-256 differs from the on-chain commitment. */
export function assertDatasetHash(bytes: Uint8Array, round: Pick<RoundView, "datasetSha256" | "roundId">): string {
  const actual = createHash("sha256").update(bytes).digest("hex");
  const committed = hex(round.datasetSha256);
  if (actual !== committed) {
    throw conflict(`Dataset hash mismatch for round ${round.roundId}: committed ${committed}, file ${actual}. Refusing to resolve.`);
  }
  return actual;
}

/** Loads the scenario file for a round and checks it against `round.dataset_sha256`. Evaluates nothing. */
export function loadCommittedDataset(round: RoundView, dir: string = oracleDataDir()) {
  const registry = loadScenarioRegistry(dir);
  let scenario;
  try {
    scenario = getScenario(registry, round.scenarioId);
  } catch {
    throw badRequest(`Unknown scenario_id ${round.scenarioId}; refusing to resolve`);
  }
  assertDatasetHash(readFileSync(join(dir, scenario.file)), round);
  const { geometry } = loadScenarioGeometry(registry, round.scenarioId, dir); // also checks the registry hash
  return { registry, scenario, geometry };
}

/** §9.3 steps 3–4: evidence v2 from the on-chain Market coordinates only. */
export function buildExchangeEvidence(market: MarketView, round: RoundView, programId: PublicKey, dir?: string): BuiltEvidenceV2 {
  const { scenario, geometry } = loadCommittedDataset(round, dir);
  const built = buildEvidenceV2({
    market: market.address.toBase58(),
    programId: programId.toBase58(),
    round: round.address.toBase58(),
    property: { id: market.propertyId, lat_e6: market.latE6, lon_e6: market.lonE6 },
    scenarioId: market.scenarioId,
    triggerDistanceM: market.triggerDistanceM,
    scenario,
    geometry,
  });
  const r = built.record;
  const ok =
    sha256Hex(built.canonical) === built.hashHex &&
    r.market === market.address.toBase58() &&
    r.round === round.address.toBase58() &&
    r.program_id === programId.toBase58() &&
    r.property.lat_e6 === market.latE6 &&
    r.property.lon_e6 === market.lonE6 &&
    r.trigger_distance_m === market.triggerDistanceM &&
    r.dataset.sha256 === hex(round.datasetSha256) &&
    canonicalize(r) === built.canonical;
  if (!ok) throw new Error("Evidence does not match on-chain market and round");
  return built;
}

export const exchangeSettlementMatches = (m: MarketView, triggered: boolean, hashHex: string): boolean =>
  m.outcome === (triggered ? "yes" : "no") && hex(m.evidenceHash) === hashHex;

export interface ExchangeOracleDeps {
  rpc?: RpcPool;
  oracle?: Keypair;
  dataDir?: string;
  send?: typeof sendExchangeTx;
}

export interface ExchangeResolveResult {
  market: string;
  status: "resolved" | "already_resolved";
  signature: string | null;
  explorer: string | null;
  hashHex: string;
}

const lock = new KeyedLock();

/** §9.3, idempotent. Waits for finalized before writing evidence. */
export async function resolveExchangeMarket(market: PublicKey, deps: ExchangeOracleDeps = {}): Promise<ExchangeResolveResult> {
  const rpc = deps.rpc ?? getRpc();
  return lock.with(market.toBase58(), async () => {
    const read = () => rpc.run((c) => fetchExchangeMarket(getExchangeProgram(c), market, "finalized"));
    const m = await read();
    if (!m) throw notFound("Market not found");
    const [round, config, now] = await Promise.all([
      rpc.run((c) => fetchRound(getExchangeProgram(c), m.round, "finalized")),
      rpc.run((c) => fetchExchangeConfig(getExchangeProgram(c), "finalized")),
      rpc.run((c) => chainNow(c, "finalized")),
    ]);
    if (!round || !config) throw unavailable("Round or Config not found");
    const gate = assertRoundGate(round, m, config, now);
    const dir = deps.dataDir ?? oracleDataDir();
    const program = getExchangeProgram(rpc.connection);
    const built = buildExchangeEvidence(m, round, program.programId, dir);

    let signature: string | null = null;
    let settled = m;
    if (gate === "resolve") {
      const oracle = deps.oracle ?? loadKeypair("oracle");
      if (!config.oracleAuthority.equals(oracle.publicKey)) throw unavailable("Oracle unavailable");
      const ix = await resolveExchangeMarketIx(program, {
        oracleAuthority: oracle.publicKey,
        round: round.address,
        market,
        triggered: built.record.triggered,
        evidenceHash: built.hashBytes,
      });
      try {
        signature = await (deps.send ?? sendExchangeTx)(rpc.connection, [ix], [oracle], { commitment: "finalized" });
      } catch {
        // A timeout or competing resolver can hide a landed transaction. The chain decides below.
      }
      settled = (await read()) ?? m;
    }
    if (!exchangeSettlementMatches(settled, built.record.triggered, built.hashHex)) {
      throw unavailable("Settlement has not been verified. Retry to check again.");
    }
    await writeEvidence(dir, market, built.canonical);
    return {
      market: market.toBase58(),
      status: gate === "resolve" ? "resolved" : "already_resolved",
      signature,
      explorer: signature ? explorerTx(signature) : null,
      hashHex: built.hashHex,
    };
  });
}

/** Liveness path (§9.5): after T anyone may expire an unresolved market to Invalid. */
export async function expireExchangeMarket(market: MarketView, caller: Keypair, rpc: RpcPool = getRpc()): Promise<string> {
  const p = getExchangeProgram(rpc.connection);
  return sendExchangeTx(rpc.connection, [await expireMarketIx(p, caller.publicKey, market.round, market.address)], [caller], {
    commitment: "finalized",
  });
}

/** §9.3 step 6: evidence only for a finalized YES/NO market whose file hash equals the on-chain hash. */
export async function getExchangeEvidence(market: PublicKey, deps: { rpc?: RpcPool; dataDir?: string } = {}) {
  const rpc = deps.rpc ?? getRpc();
  const m = await rpc
    .run((c) => fetchExchangeMarket(getExchangeProgram(c), market, "finalized"))
    .catch(() => {
      throw unavailable("Evidence temporarily unavailable");
    });
  if (!m || (m.outcome !== "yes" && m.outcome !== "no")) throw notFound("No evidence for this market yet");
  const bytes = await readEvidenceBytes(deps.dataDir ?? oracleDataDir(), market).catch(() => {
    throw unavailable("Evidence temporarily unavailable");
  });
  if (!bytes) throw notFound("No evidence for this market yet");
  const hashHex = sha256Hex(bytes);
  if (!exchangeSettlementMatches(m, m.outcome === "yes", hashHex)) throw unavailable("Evidence temporarily unavailable");
  let record: EvidenceRecordV2;
  try {
    record = JSON.parse(bytes.toString("utf8")) as EvidenceRecordV2;
  } catch {
    throw unavailable("Evidence temporarily unavailable");
  }
  if (record.version !== 2 || record.market !== market.toBase58() || record.round !== m.round.toBase58() || record.triggered !== (m.outcome === "yes")) {
    throw unavailable("Evidence temporarily unavailable");
  }
  return { market: market.toBase58(), canonical: bytes.toString("utf8"), hashHex, record, onChain: { outcome: m.outcome, evidenceHash: hashHex, matches: true } };
}
