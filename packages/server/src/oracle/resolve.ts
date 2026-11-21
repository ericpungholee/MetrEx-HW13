import { canonicalize, type BuiltEvidence } from "@metrex/geo";
import { loadScenarioRegistry } from "@metrex/geo/node";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { getScenario, type ScenarioRegistry } from "@metrex/shared";
import { fetchMarket, type MarketView } from "../accounts";
import { oracleDataDir, loadKeypair } from "../env";
import { explorerTx } from "../explorer";
import { configPda, resolveMarketIx } from "../ix";
import { getProgram } from "../program";
import { getRpc, type RpcPool } from "../rpc";
import { sendTx } from "../tx";
import { badRequest, conflict, KeyedLock, notFound, unavailable } from "../routes/errors";
import { settlementMatches } from "./evidence";
import { sha256Hex, writeEvidence } from "./evidence-store";
import { realGeo, type GeoAdapter } from "./geo-adapter";

export interface ResolveResult {
  market: string;
  signature: string | null;
  explorer: string | null;

}

export interface ResolveDeps {
  rpc?: RpcPool;
  oracle?: Keypair;
  geo?: GeoAdapter;
  dataDir?: string;
  send?: typeof sendTx;
  readMarket?: (market: PublicKey) => Promise<MarketView | null>;
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
    [canonicalize(r) === built.canonical, "canonical record"],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, what]) => what);
  if (failed.length) throw new Error(`Evidence does not match on-chain market: ${failed.join(", ")}`);
  return built;
}

const lock = new KeyedLock();

export async function resolveMarket(market: PublicKey, deps: ResolveDeps = {}): Promise<ResolveResult> {
  const rpc = deps.rpc ?? getRpc();
  return lock.with(market.toBase58(), async () => {
    const readMarket = () => deps.readMarket?.(market) ?? rpc.run((c) => fetchMarket(getProgram(c), market, "finalized"));
    const m = await readMarket();
    if (!m) throw notFound("Market not found");
    const pending = m.status === "closed";
    const alreadyResolved = m.status === "resolvedYes" || m.status === "resolvedNo";
    if (!alreadyResolved) assertResolvable(m);

    const dir = deps.dataDir ?? oracleDataDir();
    const program = getProgram(rpc.connection);
    const registry = loadScenarioRegistry(dir);
    const built = await buildMarketEvidence(m, program.programId, registry, deps.geo ?? realGeo, dir);
    let signature: string | null = null;
    let settled = m;
    if (pending) {
      const oracle = deps.oracle ?? loadKeypair("oracle");
      const config = await rpc.run((c) => getProgram(c).account.config.fetchNullable(configPda(getProgram(c))));
      if (!config?.oracleAuthority.equals(oracle.publicKey)) throw unavailable("Oracle unavailable");
      const c = rpc.connection;
      const ix = await resolveMarketIx(getProgram(c), {
        oracleAuthority: oracle.publicKey,
        market,
        triggered: built.record.triggered,
        evidenceHash: built.hashBytes,
      });
      try {
        signature = await (deps.send ?? sendTx)(c, [ix], [oracle], { commitment: "finalized" });
      } catch {
        // A timeout or competing resolver can hide a landed transaction. Check chain state.
      }
      settled = (await readMarket()) ?? m;
    }
    if (!settlementMatches(settled, built.record.triggered, built.hashHex)) {
      throw unavailable("Settlement has not been verified. Retry to check again.");
    }
    await writeEvidence(dir, market, built.canonical);
    return { market: market.toBase58(), signature, explorer: signature ? explorerTx(signature) : null };
  });
}
