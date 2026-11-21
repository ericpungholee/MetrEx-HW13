// Evidence builder (spec §8.4). Browser-safe: no Node built-ins.
// All property inputs must come from the on-chain Market / Property, never from a caller.

import { EVIDENCE_VERSION, type EvidenceRecord, type ScenarioEntry } from "@metrex/shared";
import { canonicalize, sha256Bytes } from "./canonical";
import { bytesToHex } from "@noble/hashes/utils";
import { evaluate, type FootprintGeometry } from "./evaluate";

export interface BuildEvidenceInput {
  /** Market PDA, base58. */
  market: string;
  /** Program ID, base58. */
  programId: string;
  /** From the on-chain Market (property_id, lat_e6, lon_e6). */
  property: { id: number; lat_e6: number; lon_e6: number };
  /** From the on-chain Market. */
  scenarioId: number;
  /** From the on-chain Market. */
  triggerDistanceM: number;
  /** Registry entry for `scenarioId` (see `getScenario`). */
  scenario: ScenarioEntry;
  /** Footprint loaded (and hash-verified) for `scenario`. */
  geometry: FootprintGeometry;
}

export interface BuiltEvidence {
  record: EvidenceRecord;
  /** Canonical JSON of `record`; the file written to data/evidence/<market>.json. */
  canonical: string;
  /** Lowercase hex SHA-256 of the canonical UTF-8 bytes. */
  hashHex: string;
  /** Same hash as 32 bytes (the on-chain `evidence_hash`). */
  hashBytes: Uint8Array;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function buildEvidence(input: BuildEvidenceInput): BuiltEvidence {
  const { market, programId, property, scenarioId, triggerDistanceM, scenario, geometry } = input;
  if (!BASE58.test(market)) throw new Error("market must be a base58 public key");
  if (!BASE58.test(programId)) throw new Error("programId must be a base58 public key");
  if (!Number.isSafeInteger(property.id) || property.id < 0 || property.id > 0xffff) {
    throw new Error("property.id must be a u16");
  }
  if (!Number.isSafeInteger(scenarioId) || scenarioId < 0 || scenarioId > 0xffff) {
    throw new Error("scenarioId must be a u16");
  }
  if (scenario.scenarioId !== scenarioId) {
    throw new Error(`Scenario entry ${scenario.scenarioId} does not match scenario_id ${scenarioId}`);
  }

  const result = evaluate(geometry, {
    lat_e6: property.lat_e6,
    lon_e6: property.lon_e6,
    trigger_distance_m: triggerDistanceM,
  });

  const record: EvidenceRecord = {
    computed: { distance_m: result.distance_m, inside: result.inside },
    dataset: {
      name: scenario.name,
      retrieved: scenario.retrieved,
      sha256: scenario.sha256,
      source: scenario.source,
    },
    market,
    program_id: programId,
    property: { id: property.id, lat_e6: property.lat_e6, lon_e6: property.lon_e6 },
    scenario_id: scenarioId,
    trigger_distance_m: triggerDistanceM,
    triggered: result.triggered,
    version: EVIDENCE_VERSION,
  };

  const canonical = canonicalize(record);
  const hashBytes = sha256Bytes(new TextEncoder().encode(canonical));
  return { record, canonical, hashHex: bytesToHex(hashBytes), hashBytes };
}

/**
 * Re-verify an evidence file in the browser: returns the hex SHA-256 of the file's
 * canonical form and whether the given text already was canonical.
 */
export function verifyEvidenceText(text: string): { hashHex: string; isCanonical: boolean } {
  const parsed: unknown = JSON.parse(text);
  const canonical = canonicalize(parsed);
  const hashHex = bytesToHex(sha256Bytes(new TextEncoder().encode(canonical)));
  return { hashHex, isCanonical: canonical === text };
}
