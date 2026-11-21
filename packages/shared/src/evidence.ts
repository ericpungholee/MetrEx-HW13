// Evidence record (spec §8.4). FROZEN after Gate 0.
// Canonical form: UTF-8, keys sorted at every level, no whitespace, integers only.
// evidence_hash = SHA-256(canonical bytes). Canonicalization lives in @metrex/geo.

export const EVIDENCE_VERSION = 1 as const;

export interface EvidenceRecord {
  computed: {
    /** Integer metres, floored. Minimum geodesic distance to any ring. */
    distance_m: number;
    /** In an outer ring and in none of its holes. */
    inside: boolean;
  };
  dataset: {
    name: string;
    /** YYYY-MM-DD */
    retrieved: string;
    /** Lowercase hex SHA-256 of the normalized dataset file. */
    sha256: string;
    source: string;
  };
  /** Market PDA, base58. */
  market: string;
  /** Program ID, base58. */
  program_id: string;
  property: {
    id: number;
    lat_e6: number;
    lon_e6: number;
  };
  scenario_id: number;
  trigger_distance_m: number;
  triggered: boolean;
  version: typeof EVIDENCE_VERSION;
}
