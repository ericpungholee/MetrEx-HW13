// Trigger evaluation (spec §8.2). Browser-safe: no Node built-ins.
//
//   point     = (lon_e6 / 1e6, lat_e6 / 1e6)
//   inside    = point lies in some polygon's outer ring AND in none of that polygon's holes
//   distance  = min geodesic distance (m) from point to ANY ring (outer or inner) of any polygon
//   triggered = inside OR distance <= trigger_distance_m
//
// Floor the reported distance for canonical evidence. Compare the full distance for settlement.

import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { lineString, point, polygon } from "@turf/helpers";
import { pointToLineDistance } from "@turf/point-to-line-distance";
import type { MultiPolygon, Polygon, Position } from "geojson";
import { MAX_ABS_LAT_E6, MAX_ABS_LON_E6 } from "@metrex/shared";

/** Footprint geometry accepted by `evaluate`. */
export type FootprintGeometry = Polygon | MultiPolygon;

export interface EvaluateInput {
  /** Latitude x 1e6 (integer), from the on-chain Market. */
  lat_e6: number;
  /** Longitude x 1e6 (integer), from the on-chain Market. */
  lon_e6: number;
  /** Trigger radius in metres (integer), from the on-chain Market. */
  trigger_distance_m: number;
}

export interface EvaluateResult {
  /** In some polygon's outer ring and in none of that polygon's holes. */
  inside: boolean;
  /** Minimum geodesic distance to any ring, metres, floored to an integer. */
  distance_m: number;
  /** Inside or within the trigger radius at full precision. */
  triggered: boolean;
}

function assertInt(name: string, v: number, maxAbs: number): void {
  if (!Number.isSafeInteger(v) || Math.abs(v) > maxAbs) {
    throw new Error(`${name} must be an integer with |${name}| <= ${maxAbs}, got ${String(v)}`);
  }
}

/** Polygons (each an array of rings: outer first, then holes) of a footprint. */
export function footprintPolygons(geometry: FootprintGeometry): Position[][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  throw new Error(`Unsupported geometry type ${(geometry as { type: string }).type}`);
}

export function evaluate(geometry: FootprintGeometry, input: EvaluateInput): EvaluateResult {
  assertInt("lat_e6", input.lat_e6, MAX_ABS_LAT_E6);
  assertInt("lon_e6", input.lon_e6, MAX_ABS_LON_E6);
  assertInt("trigger_distance_m", input.trigger_distance_m, 0xffff_ffff);
  if (input.trigger_distance_m < 0) throw new Error("trigger_distance_m must be >= 0");

  const polys = footprintPolygons(geometry);
  if (polys.length === 0) throw new Error("Footprint has no polygons");

  const pt = point([input.lon_e6 / 1e6, input.lat_e6 / 1e6]);

  let inside = false;
  let minDistance = Number.POSITIVE_INFINITY;
  for (const rings of polys) {
    if (rings.length === 0) throw new Error("Polygon has no rings");
    // booleanPointInPolygon on a Polygon (outer + holes) excludes points inside holes.
    if (!inside && booleanPointInPolygon(pt, polygon(rings))) inside = true;
    for (const ring of rings) {
      const d = pointToLineDistance(pt, lineString(ring), { units: "meters", method: "geodesic" });
      if (d < minDistance) minDistance = d;
    }
  }
  if (!Number.isFinite(minDistance) || minDistance < 0) {
    throw new Error(`Distance computation failed: ${String(minDistance)}`);
  }

  const distance_m = Math.floor(minDistance);
  return { inside, distance_m, triggered: inside || minDistance <= input.trigger_distance_m };
}
