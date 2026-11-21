// POST /api/oracle/resolve/:market (spec §8, §9.2). Reads the Market, requires Closed, loads
// the dataset by market.scenario_id from data/scenarios.json (refusing unknown IDs), evaluates
// using ONLY the on-chain market coordinates, writes the canonical evidence file, then signs
// resolve_market(triggered, sha256(canonical)) with the oracle key.

import type { BuiltEvidence } from "@metrex/geo";
import { loadScenarioRegistry } from "@metrex/geo/node";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { getScenario, type EvidenceRecord, type ScenarioRegistry } from "@metrex/shared";
import { fetchMarket, type MarketView } from "../accounts";
import { dataDir as defaultDataDir, loadKeypair } from "../env";
import { explorerTx } from "../explorer";
import { configPda, resolveMarketIx } from "../ix";
import { getProgram } from "../program";
import { getRpc, type RpcPool } from "../rpc";
import { sendTx } from "../tx";
import { badRequest, conflict, KeyedLock, notFound, unavailable } from "../routes/errors";
import { sha256Hex, writeEvidence } from "./evidence-store";
import { realGeo, type GeoAdapter } from "./geo-adapter";

export interface ResolveResult {
  market: string;
  signature: string;
  explorer: string;
  triggered: boolean;
  evidenceHash: string;
  evidence: EvidenceRecord;
  evidencePath: string;
}

export interface ResolveDeps {
  rpc?: RpcPool;
  oracle?: Keypair;
  geo?: GeoAdapter;
  dataDir?: string;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** State checks shared by the route and tests. */
export function assertResolvable(m: MarketView): void {
  switch (m.status) {
    case "closed":
      return;
    case "open":
      throw conflict("Market is still Open; close it before resolving");
    case "resolvedYes":
    case "resolvedNo":
      throw conflict("Market is already resolved");
    case "voided":
      throw conflict("Market is voided");
  }
}

/**
 * Pure step: builds and cross-checks evidence for an on-chain market. Throws on an unknown
 * scenario or any mismatch between the evidence record and on-chain state.
 */
export async function buildMarketEvidence(
  m: MarketView,
  programId: PublicKey,
  registry: ScenarioRegistry,
  geo: GeoAdapter,
  dir: string,
): Promise<BuiltEvidence> {
  let scenario;
  try {
    scenario = getScenario(registry, m.scenarioId);
  } catch {
    throw badRequest(`Unknown scenario_id ${m.scenarioId}; refusing to resolve`);
  }
  const geometry = await geo.loadScenarioGeometry(registry, m.scenarioId, dir);
  const built = await geo.buildEvidence({
    market: m.pubkey.toBase58(),
    programId: programId.toBase58(),
    property: { id: m.propertyId, lat_e6: m.latE6, lon_e6: m.lonE6 },
    scenarioId: m.scenarioId,
    triggerDistanceM: m.triggerDistanceM,
    scenario,
    geometry,
  });
  const r = built.record;
  const checks: [boolean, string][] = [
    [sha256Hex(built.canonical) === built.hashHex.toLowerCase(), "hashHex != sha256(canonical)"],
    [built.hashBytes.length === 32 && hex(built.hashBytes) === built.hashHex.toLowerCase(), "hashBytes != hashHex"],
    [r.market === m.pubkey.toBase58(), "record.market"],
    [r.program_id === programId.toBase58(), "record.program_id"],
    [r.property.id === m.propertyId, "record.property.id"],
    [r.property.lat_e6 === m.latE6 && r.property.lon_e6 === m.lonE6, "record.property coordinates"],
    [r.scenario_id === m.scenarioId, "record.scenario_id"],
    [r.trigger_distance_m === m.triggerDistanceM, "record.trigger_distance_m"],
    [typeof r.triggered === "boolean", "record.triggered"],
    [(JSON.parse(built.canonical) as EvidenceRecord).triggered === r.triggered, "canonical.triggered"],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, what]) => what);
  if (failed.length) throw new Error(`Evidence does not match on-chain market: ${failed.join(", ")}`);
  return built;
}

const lock = new KeyedLock();

export async function resolveMarket(market: PublicKey, deps: ResolveDeps = {}): Promise<ResolveResult> {
  const rpc = deps.rpc ?? getRpc();
  const oracle = deps.oracle ?? loadKeypair("oracle");
  const geo = deps.geo ?? realGeo;
  const dir = deps.dataDir ?? defaultDataDir();
  return lock.with(market.toBase58(), async () => {
    const m = await rpc.run((c) => fetchMarket(getProgram(c), market));
    if (!m) throw notFound("Market not found");
    assertResolvable(m);
    const config = await rpc.run((c) => getProgram(c).account.config.fetchNullable(configPda(getProgram(c))));
    if (!config) throw unavailable("Config is not initialized");
    if (!config.oracleAuthority.equals(oracle.publicKey)) {
      throw unavailable("Configured oracle key does not match config.oracle_authority");
    }
    const registry = loadScenarioRegistry(dir);
    const c = rpc.connection;
    const program = getProgram(c);
    const built = await buildMarketEvidence(m, program.programId, registry, geo, dir);
    const evidencePath = await writeEvidence(dir, market, built.canonical);
    const ix = await resolveMarketIx(program, {
      oracleAuthority: oracle.publicKey,
      market,
      triggered: built.record.triggered,
      evidenceHash: built.hashBytes,
    });
    const signature = await sendTx(c, [ix], [oracle]);
    return {
      market: market.toBase58(),
      signature,
      explorer: explorerTx(signature),
      triggered: built.record.triggered,
      evidenceHash: built.hashHex.toLowerCase(),
      evidence: built.record,
      evidencePath,
    };
  });
}
