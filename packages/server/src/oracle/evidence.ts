// Evidence and perimeter publication share the same finalized on-chain gate.
import type { PublicKey } from "@solana/web3.js";
import { loadScenarioGeometry, loadScenarioRegistry } from "@metrex/geo/node";
import type { EvidenceRecord } from "@metrex/shared";
import { fetchMarket, type MarketView } from "../accounts";
import { dataDir as defaultDataDir } from "../env";
import { getProgram } from "../program";
import { getRpc, type RpcPool } from "../rpc";
import { notFound, unavailable } from "../routes/errors";
import { readEvidenceBytes, sha256Hex } from "./evidence-store";

export function settlementMatches(m: MarketView, triggered: boolean, hash: string): boolean {
  return m.status === (triggered ? "resolvedYes" : "resolvedNo") &&
    Buffer.from(m.evidenceHash).toString("hex") === hash;
}

export interface EvidenceDeps {
  rpc?: RpcPool;
  dataDir?: string;
  readMarket?: (market: PublicKey) => Promise<MarketView | null>;
}

export async function getEvidence(market: PublicKey, deps: EvidenceDeps = {}) {
  const readMarket = deps.readMarket ?? ((key: PublicKey) =>
    (deps.rpc ?? getRpc()).run((c) => fetchMarket(getProgram(c), key, "finalized")));
  const m = await readMarket(market).catch(() => { throw unavailable("Evidence temporarily unavailable"); });
  if (!m || (m.status !== "resolvedYes" && m.status !== "resolvedNo")) {
    throw notFound("No evidence for this market yet");
  }

  const bytes = await readEvidenceBytes(deps.dataDir ?? defaultDataDir(), market);
  if (!bytes) throw notFound("No evidence for this market yet");
  const hashHex = sha256Hex(bytes);
  if (!settlementMatches(m, m.status === "resolvedYes", hashHex)) {
    throw unavailable("Evidence temporarily unavailable");
  }
  const canonical = bytes.toString("utf8");
  const record = JSON.parse(canonical) as EvidenceRecord;
  if (record.market !== market.toBase58() || record.scenario_id !== m.scenarioId ||
      record.triggered !== (m.status === "resolvedYes")) {
    throw unavailable("Evidence temporarily unavailable");
  }
  return {
    market: market.toBase58(), canonical, hashHex, record,
    onChain: { status: m.status, evidenceHash: hashHex, matches: true },
  };
}

export async function getSettledPerimeter(market: PublicKey, deps: EvidenceDeps = {}) {
  const evidence = await getEvidence(market, deps);
  try {
    const dir = deps.dataDir ?? defaultDataDir();
    const { scenario, geometry } = loadScenarioGeometry(loadScenarioRegistry(dir), evidence.record.scenario_id, dir);
    if (scenario.sha256.toLowerCase() !== evidence.record.dataset.sha256) {
      throw new Error("Dataset changed");
    }
    return geometry;
  } catch {
    throw unavailable("Perimeter temporarily unavailable");
  }
}
