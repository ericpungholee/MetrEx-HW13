// Normalize the raw WFIGS Palisades perimeter (spec §8.1). Idempotent and deterministic.
//
//   pnpm tsx scripts/normalize-perimeter.ts
//
// Input:  data/raw/wfigs-palisades-2025.geojson (NIFC WFIGS Interagency Perimeters, OBJECTID 36398)
// Output: data/palisades-2025.geojson — FeatureCollection with exactly one Feature whose
//         geometry is a single MultiPolygon (WGS84 lon/lat), every ring (outer + holes) kept,
//         coordinates copied verbatim (no simplification, no reordering), minimal properties,
//         fixed key order, compact JSON + trailing newline.
// No network access.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "@metrex/geo";

const RAW_SHA256 = "a88cb3a7785ad1b108c3edc84ddb948885a5a03c291e18a28e3d16a0bb45c6ba";
const EXPECTED_UNIQUE_FIRE_ID = "2025-CALFD-000738";
const EXPECTED_OBJECTID = 36398;

const dataDir = join(__dirname, "..", "data");
const rawPath = join(dataDir, "raw", "wfigs-palisades-2025.geojson");
const outPath = join(dataDir, "palisades-2025.geojson");

type Pos = number[];

interface RawFeature {
  type: string;
  id?: number;
  geometry: { type: string; coordinates: unknown };
  properties: Record<string, unknown>;
}

function fail(msg: string): never {
  throw new Error(`normalize-perimeter: ${msg}`);
}

const rawBytes = readFileSync(rawPath);
const rawHash = sha256Hex(new Uint8Array(rawBytes));
if (rawHash !== RAW_SHA256) fail(`raw SHA-256 ${rawHash} != expected ${RAW_SHA256}`);

const raw = JSON.parse(rawBytes.toString("utf8")) as {
  type: string;
  crs?: { properties?: { name?: string } };
  features: RawFeature[];
};
if (raw.type !== "FeatureCollection") fail("raw is not a FeatureCollection");
const crs = raw.crs?.properties?.name;
if (crs !== undefined && crs !== "EPSG:4326") fail(`unexpected CRS ${crs}`);
if (raw.features.length !== 1) fail(`expected 1 feature, got ${raw.features.length}`);
const feature = raw.features[0]!;
const props = feature.properties;
if (props["attr_UniqueFireIdentifier"] !== EXPECTED_UNIQUE_FIRE_ID) fail("unique fire id mismatch");
if (props["OBJECTID"] !== EXPECTED_OBJECTID) fail("OBJECTID mismatch");

// Collect polygons (array of rings) from Polygon or MultiPolygon.
let polygons: Pos[][][];
if (feature.geometry.type === "MultiPolygon") polygons = feature.geometry.coordinates as Pos[][][];
else if (feature.geometry.type === "Polygon") polygons = [feature.geometry.coordinates as Pos[][]];
else fail(`unsupported geometry ${feature.geometry.type}`);

let rings = 0;
let holes = 0;
let vertices = 0;
const out: Pos[][][] = polygons.map((poly, pi) => {
  if (poly.length === 0) fail(`polygon ${pi} has no rings`);
  holes += poly.length - 1;
  return poly.map((ring, ri) => {
    rings++;
    if (ring.length < 4) fail(`polygon ${pi} ring ${ri} has < 4 positions`);
    const first = ring[0]!;
    const last = ring[ring.length - 1]!;
    if (first[0] !== last[0] || first[1] !== last[1]) fail(`polygon ${pi} ring ${ri} not closed`);
    return ring.map((p) => {
      vertices++;
      const lon = p[0];
      const lat = p[1];
      if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat)) {
        fail(`bad position in polygon ${pi} ring ${ri}`);
      }
      if (Math.abs(lon) > 180 || Math.abs(lat) > 90) fail("position out of WGS84 range");
      return [lon, lat]; // drop any Z/M; none present in the raw file
    });
  });
});

if (JSON.stringify(out) !== JSON.stringify(polygons)) fail("coordinates changed during normalization");

const normalized = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        name: "Palisades Fire, January 2025",
        source: "NIFC WFIGS Interagency Perimeters",
        source_objectid: EXPECTED_OBJECTID,
        unique_fire_id: EXPECTED_UNIQUE_FIRE_ID,
      },
      geometry: { type: "MultiPolygon", coordinates: out },
    },
  ],
};

const text = JSON.stringify(normalized) + "\n";
writeFileSync(outPath, text);
const outHash = sha256Hex(new TextEncoder().encode(text));

console.log(`raw        ${rawHash}  data/raw/wfigs-palisades-2025.geojson`);
console.log(`normalized ${outHash}  data/palisades-2025.geojson`);
console.log(`polygons=${out.length} rings=${rings} holes=${holes} vertices=${vertices} bytes=${Buffer.byteLength(text)}`);
