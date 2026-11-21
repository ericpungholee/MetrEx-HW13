// Multi-peril hazard datasets, trigger evaluation and evidence v3 (spec-v2 addendum
// docs/spec-multiperil.md §4–§5). Browser-safe: no Node built-ins. Additive: the wildfire path
// (evaluate / buildEvidenceV2, scenario 1) is unchanged.
//
// Every dataset file pins its own rule (hazard, method, threshold, coverage window) inside the
// bytes that `round.dataset_sha256` commits to. Every evaluation returns integers only.

import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { lineString, point, polygon } from "@turf/helpers";
import { pointToLineDistance } from "@turf/point-to-line-distance";
import { bytesToHex } from "@noble/hashes/utils";
import type { MultiLineString, MultiPolygon, Position } from "geojson";
import { canonicalize, sha256Bytes } from "./canonical";

export const EVIDENCE_VERSION_V3 = 3 as const;

export type HazardKind = "wildfire" | "hurricane" | "earthquake" | "tornado";

/** How a dataset is evaluated against a property point. */
export type HazardMethod =
  /** Inside any footprint polygon (trigger_distance_m must be 0). */
  | "inside_footprint"
  /** Geodesic distance to any track line ≤ trigger_distance_m. */
  | "track_proximity"
  /** Intensity at the nearest grid node ≥ threshold_x10. */
  | "nearest_node_intensity";

/** Pinned rule. Lives inside the hashed dataset file. */
export interface HazardRule {
  hazard: HazardKind;
  method: HazardMethod;
  /** Plain-text threshold, e.g. "64 kt sustained wind swath". */
  threshold: string;
  /** Integer threshold for `nearest_node_intensity` (MMI × 10); 0 otherwise. */
  threshold_x10: number;
  /** Coverage window, ISO 8601 UTC, start inclusive, end exclusive. */
  coverage_start: string;
  coverage_end: string;
  /** IANA zone the calendar month is defined in. */
  timezone: string;
}

export interface HazardMeta {
  version: 1;
  /** Matches the scenario registry `name`. */
  name: string;
  rule: HazardRule;
  /** Upstream sources, as URLs or query descriptions. */
  sources: string[];
}

export interface FootprintFeature {
  type: "Feature";
  properties: { id: string; label: string; start: string; end: string };
  geometry: MultiPolygon;
}

export interface TrackFeature {
  type: "Feature";
  properties: { id: string; label: string; start: string; end: string };
  geometry: MultiLineString;
}

export interface FootprintDataset {
  type: "FeatureCollection";
  metrex: HazardMeta;
  features: FootprintFeature[];
}

export interface TrackDataset {
  type: "FeatureCollection";
  metrex: HazardMeta;
  features: TrackFeature[];
}

export interface IntensityGridDataset {
  type: "MetrexIntensityGrid";
  metrex: HazardMeta;
  event: { id: string; label: string; time: string; magnitude_x10: number };
  /** Maximum distance from the property to the nearest node, else the property is not covered. */
  max_node_distance_m: number;
  /** `[lon × 1e4, lat × 1e4, MMI × 10]`, integers copied exactly from the source grid. */
  nodes: [number, number, number][];
}

export type HazardDataset = FootprintDataset | TrackDataset | IntensityGridDataset;

export interface HazardInput {
  lat_e6: number;
  lon_e6: number;
  trigger_distance_m: number;
}

/** Hazard-specific computed values. Integers, booleans and strings only (canonical JSON). */
export type HazardComputed =
  | { inside: boolean; distance_m: number; nearest_feature: string; containing_feature: string }
  | { distance_m: number; nearest_feature: string }
  | { mmi_x10: number; node_lon_e4: number; node_lat_e4: number; node_distance_m: number };

export interface HazardResult {
  computed: HazardComputed;
  triggered: boolean;
}

const MAX_ABS_LAT_E6 = 90_000_000;
const MAX_ABS_LON_E6 = 180_000_000;

function assertPoint(input: HazardInput): void {
  const ok = (v: number, max: number) => Number.isSafeInteger(v) && Math.abs(v) <= max;
  if (!ok(input.lat_e6, MAX_ABS_LAT_E6) || !ok(input.lon_e6, MAX_ABS_LON_E6)) {
    throw new Error("lat_e6/lon_e6 must be in-range integers");
  }
  if (!Number.isSafeInteger(input.trigger_distance_m) || input.trigger_distance_m < 0 || input.trigger_distance_m > 0xffff_ffff) {
    throw new Error("trigger_distance_m must be a u32");
  }
}

/** Validates the structure and rule of a parsed dataset. Throws on anything unexpected. */
export function assertHazardDataset(d: unknown): asserts d is HazardDataset {
  const x = d as Partial<HazardDataset> | null;
  const meta = x?.metrex;
  if (!x || !meta || meta.version !== 1 || typeof meta.name !== "string" || !meta.rule) {
    throw new Error("Not a MetrEx hazard dataset");
  }
  const r = meta.rule;
  const months = Date.parse(r.coverage_end) - Date.parse(r.coverage_start);
  if (!(months > 0)) throw new Error("Coverage window is empty or invalid");
  if (r.method === "nearest_node_intensity") {
    const g = x as IntensityGridDataset;
    if (g.type !== "MetrexIntensityGrid" || !Array.isArray(g.nodes) || g.nodes.length === 0) {
      throw new Error("Intensity dataset has no nodes");
    }
    if (!Number.isSafeInteger(r.threshold_x10) || r.threshold_x10 <= 0) throw new Error("threshold_x10 must be positive");
    for (const n of g.nodes) {
      if (n.length !== 3 || !n.every(Number.isSafeInteger)) throw new Error("Grid nodes must be integer triples");
    }
    return;
  }
  const fc = x as FootprintDataset | TrackDataset;
  if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features) || fc.features.length === 0) {
    throw new Error("Hazard dataset has no features");
  }
  const want = r.method === "inside_footprint" ? "MultiPolygon" : r.method === "track_proximity" ? "MultiLineString" : null;
  if (!want) throw new Error(`Unknown method ${String(r.method)}`);
  for (const f of fc.features) {
    if (f.geometry?.type !== want) throw new Error(`Feature ${f.properties?.id} must be a ${want}`);
  }
}

/** Evaluates a property against a validated dataset. Settlement compares at full precision. */
export function evaluateHazard(d: HazardDataset, input: HazardInput): HazardResult {
  assertPoint(input);
  const rule = d.metrex.rule;
  const pt = point([input.lon_e6 / 1e6, input.lat_e6 / 1e6]);

  if (rule.method === "inside_footprint") {
    if (input.trigger_distance_m !== 0) throw new Error("inside_footprint markets must have trigger_distance_m = 0");
    let containing = "";
    let nearest = "";
    let min = Number.POSITIVE_INFINITY;
    for (const f of (d as FootprintDataset).features) {
      for (const rings of f.geometry.coordinates) {
        if (!containing && booleanPointInPolygon(pt, polygon(rings))) containing = f.properties.id;
        for (const ring of rings) {
          const dist = pointToLineDistance(pt, lineString(ring), { units: "meters", method: "geodesic" });
          if (dist < min) {
            min = dist;
            nearest = f.properties.id;
          }
        }
      }
    }
    if (!Number.isFinite(min)) throw new Error("Distance computation failed");
    const inside = containing !== "";
    return {
      computed: { inside, distance_m: Math.floor(min), nearest_feature: nearest, containing_feature: containing },
      triggered: inside,
    };
  }

  if (rule.method === "track_proximity") {
    if (input.trigger_distance_m <= 0) throw new Error("track_proximity markets need trigger_distance_m > 0");
    let nearest = "";
    let min = Number.POSITIVE_INFINITY;
    for (const f of (d as TrackDataset).features) {
      for (const line of f.geometry.coordinates) {
        const dist = pointToLineDistance(pt, lineString(line as Position[]), { units: "meters", method: "geodesic" });
        if (dist < min) {
          min = dist;
          nearest = f.properties.id;
        }
      }
    }
    if (!Number.isFinite(min)) throw new Error("Distance computation failed");
    return { computed: { distance_m: Math.floor(min), nearest_feature: nearest }, triggered: min <= input.trigger_distance_m };
  }

  // nearest_node_intensity
  if (input.trigger_distance_m !== 0) throw new Error("nearest_node_intensity markets must have trigger_distance_m = 0");
  const g = d as IntensityGridDataset;
  let best = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < g.nodes.length; i++) {
    const [lonE4, latE4] = g.nodes[i]!;
    const dist = geodesicMeters(input.lat_e6 / 1e6, input.lon_e6 / 1e6, latE4 / 1e4, lonE4 / 1e4);
    // Strictly less: ties keep the lower index, so the choice is deterministic.
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  if (best < 0 || bestDist > g.max_node_distance_m) {
    // Missing evidence never settles NO: the oracle refuses and the market can only expire Invalid.
    throw new Error(`Property is not covered by the intensity grid (nearest node ${Math.floor(bestDist)} m)`);
  }
  const [lonE4, latE4, mmiX10] = g.nodes[best]!;
  return {
    computed: { mmi_x10: mmiX10, node_lon_e4: lonE4, node_lat_e4: latE4, node_distance_m: Math.floor(bestDist) },
    triggered: mmiX10 >= rule.threshold_x10,
  };
}

/** Haversine on the IUGG mean radius. Used only to pick the nearest grid node (~0.9 km spacing). */
export function geodesicMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_008.8;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------- Evidence v3 ----------

export interface EvidenceRecordV3 {
  computed: HazardComputed;
  coverage: { end: string; start: string; timezone: string };
  dataset: { name: string; retrieved: string; sha256: string; source: string };
  hazard: HazardKind;
  market: string;
  program_id: string;
  property: { id: number; lat_e6: number; lon_e6: number };
  round: string;
  rule: { method: HazardMethod; threshold: string; threshold_x10: number };
  scenario_id: number;
  trigger_distance_m: number;
  triggered: boolean;
  version: typeof EVIDENCE_VERSION_V3;
}

export interface BuildEvidenceV3Input {
  market: string;
  round: string;
  programId: string;
  /** From the on-chain Market. */
  property: { id: number; lat_e6: number; lon_e6: number };
  scenarioId: number;
  triggerDistanceM: number;
  /** Registry entry fields for `scenarioId`. */
  scenario: { scenarioId: number; name: string; sha256: string; source: string; retrieved: string };
  dataset: HazardDataset;
}

export interface BuiltEvidenceV3 {
  record: EvidenceRecordV3;
  canonical: string;
  hashHex: string;
  hashBytes: Uint8Array;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function buildEvidenceV3(input: BuildEvidenceV3Input): BuiltEvidenceV3 {
  const { market, round, programId, property, scenarioId, triggerDistanceM, scenario, dataset } = input;
  for (const [k, v] of [["market", market], ["round", round], ["programId", programId]] as const) {
    if (!BASE58.test(v)) throw new Error(`${k} must be a base58 public key`);
  }
  if (!Number.isSafeInteger(property.id) || property.id < 0 || property.id > 0xffff) throw new Error("property.id must be a u16");
  if (scenario.scenarioId !== scenarioId) throw new Error(`Scenario entry ${scenario.scenarioId} does not match scenario_id ${scenarioId}`);
  if (dataset.metrex.name !== scenario.name) throw new Error(`Dataset ${dataset.metrex.name} is not scenario ${scenario.name}`);

  const result = evaluateHazard(dataset, { lat_e6: property.lat_e6, lon_e6: property.lon_e6, trigger_distance_m: triggerDistanceM });
  const rule = dataset.metrex.rule;
  const record: EvidenceRecordV3 = {
    computed: result.computed,
    coverage: { end: rule.coverage_end, start: rule.coverage_start, timezone: rule.timezone },
    dataset: { name: scenario.name, retrieved: scenario.retrieved, sha256: scenario.sha256, source: scenario.source },
    hazard: rule.hazard,
    market,
    program_id: programId,
    property: { id: property.id, lat_e6: property.lat_e6, lon_e6: property.lon_e6 },
    round,
    rule: { method: rule.method, threshold: rule.threshold, threshold_x10: rule.threshold_x10 },
    scenario_id: scenarioId,
    trigger_distance_m: triggerDistanceM,
    triggered: result.triggered,
    version: EVIDENCE_VERSION_V3,
  };
  const canonical = canonicalize(record);
  const hashBytes = sha256Bytes(new TextEncoder().encode(canonical));
  return { record, canonical, hashHex: bytesToHex(hashBytes), hashBytes };
}
