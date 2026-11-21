// GET /api/evidence/:market (spec §8.4). Serves the exact canonical bytes so the browser can
// recompute SHA-256 and compare with the on-chain Market.evidence_hash.

import type { PublicKey } from "@solana/web3.js";
import type { EvidenceRecord } from "@metrex/shared";
import { fetchMarket } from "../accounts";
import { dataDir as defaultDataDir } from "../env";
import { getProgram } from "../program";
import { getRpc, type RpcPool } from "../rpc";
import { notFound } from "../routes/errors";
import { readEvidenceBytes, sha256Hex } from "./evidence-store";

export interface EvidenceResult {
  market: string;
  /** Canonical JSON exactly as hashed. */
  canonical: string;
  hashHex: string;
  record: EvidenceRecord;
  /** On-chain hash (hex) and whether it equals `hashHex`; null if the market can't be read. */
  onChain: { status: string; evidenceHash: string; matches: boolean } | null;
}

export async function getEvidence(
  market: PublicKey,
  deps: { rpc?: RpcPool; dataDir?: string; skipChain?: boolean } = {},
): Promise<EvidenceResult> {
  const bytes = await readEvidenceBytes(deps.dataDir ?? defaultDataDir(), market);
  if (!bytes) throw notFound("No evidence for this market yet");
  const canonical = bytes.toString("utf8");
  const hashHex = sha256Hex(bytes);
  let onChain: EvidenceResult["onChain"] = null;
  if (!deps.skipChain) {
    try {
      const rpc = deps.rpc ?? getRpc();
      const m = await rpc.run((c) => fetchMarket(getProgram(c), market));
      if (m) {
        const h = Buffer.from(m.evidenceHash).toString("hex");
        onChain = { status: m.status, evidenceHash: h, matches: h === hashHex };
      }
    } catch {
      onChain = null;
    }
  }
  return {
    market: market.toBase58(),
    canonical,
    hashHex,
    record: JSON.parse(canonical) as EvidenceRecord,
    onChain,
  };
}
