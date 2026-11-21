// Select demo properties from the real normalized perimeter (spec §8.3). Deterministic, offline.
//
//   pnpm tsx scripts/find-properties.ts            # print candidates + selection
//   pnpm tsx scripts/find-properties.ts --write    # also write data/properties.json
//
// Every coordinate is a grid point on a 0.001° lattice (~100 m), so points are approximate,
// not street addresses. The grid is iterated in integer micro-degrees (lat_e6/lon_e6), so
// there is no float rounding between "chosen" and "registered" values; each chosen point is
// re-evaluated with evaluate() exactly as the oracle will. Labels are fictional. No
// damage-inspection (DINS) data is used.
//
// Selection rules:
//   1 "Palisades · Home #1042"  YES  inside, not in a hole, distance to every ring ≥ 300 m,
//                                     within the Pacific Palisades search window; the qualifying
//                                     grid point nearest the search anchor.
//   3 "Palisades · Home #1187"  YES  same rule, and ≥ 1.5 km from property 1 (clearly separate).
//   2 "Westside · Home #2210"   NO   outside, 3–6 km from every ring (spec minimum is 2 km),
//                                     within the Brentwood search window (east of the coastline,
//                                     so on land); the qualifying grid point whose distance is
//                                     nearest 4 km.
// Ties break on (lat_e6, lon_e6) ascending.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TRIGGER_DISTANCE_M, SCENARIO_PALISADES_2025 } from "@metrex/shared";
import { evaluate, type EvaluateResult } from "@metrex/geo";
import { loadScenarioGeometry, loadScenarioRegistry } from "@metrex/geo/node";

const STEP_E6 = 1_000; // 0.001°
const TRIGGER = DEFAULT_TRIGGER_DISTANCE_M;

interface Window {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

// Approximate Pacific Palisades community area (west of Santa Monica Canyon, south of the
// Santa Monica Mountains ridge). The anchor is the placeholder point printed in spec §8.4,
// used only to pick deterministically among qualifying points near the community core.
const PALISADES: Window = { latMin: 34_030_000, latMax: 34_080_000, lonMin: -118_570_000, lonMax: -118_500_000 };
const PALISADES_ANCHOR = { lat_e6: 34_045_000, lon_e6: -118_526_000 };

// Approximate Brentwood, west Los Angeles. Everything here is east of lon -118.48 and north of
// lat 34.03, i.e. inland of the Santa Monica Bay coastline.
const WESTSIDE: Window = { latMin: 34_030_000, latMax: 34_080_000, lonMin: -118_480_000, lonMax: -118_440_000 };

interface Candidate extends EvaluateResult {
  lat_e6: number;
  lon_e6: number;
}

function haversineM(a: { lat_e6: number; lon_e6: number }, b: { lat_e6: number; lon_e6: number }): number {
  const R = 6_371_008.8;
  const rad = (e6: number) => (e6 / 1e6) * (Math.PI / 180);
  const dLat = rad(b.lat_e6 - a.lat_e6);
  const dLon = rad(b.lon_e6 - a.lon_e6);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat_e6)) * Math.cos(rad(b.lat_e6)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const dataDir = join(__dirname, "..", "data");
const { geometry, scenario } = loadScenarioGeometry(loadScenarioRegistry(dataDir), SCENARIO_PALISADES_2025, dataDir);

function scan(w: Window): Candidate[] {
  const out: Candidate[] = [];
  for (let lat = w.latMin; lat <= w.latMax; lat += STEP_E6) {
    for (let lon = w.lonMin; lon <= w.lonMax; lon += STEP_E6) {
      const r = evaluate(geometry, { lat_e6: lat, lon_e6: lon, trigger_distance_m: TRIGGER });
      out.push({ lat_e6: lat, lon_e6: lon, ...r });
    }
  }
  return out;
}

function byKey<T extends { lat_e6: number; lon_e6: number }>(key: (c: T) => number) {
  return (a: T, b: T) => key(a) - key(b) || a.lat_e6 - b.lat_e6 || a.lon_e6 - b.lon_e6;
}

function fmt(c: Candidate): string {
  return `lat_e6=${c.lat_e6} lon_e6=${c.lon_e6} (${(c.lat_e6 / 1e6).toFixed(3)}, ${(c.lon_e6 / 1e6).toFixed(3)}) inside=${c.inside} distance_m=${c.distance_m} triggered=${c.triggered}`;
}

console.log(`dataset ${scenario.name} sha256=${scenario.sha256}`);

const pal = scan(PALISADES);
const palOk = pal.filter((c) => c.inside && c.distance_m >= 300);
console.log(`Palisades window: ${pal.length} grid points, ${pal.filter((c) => c.inside).length} inside, ${palOk.length} inside with ≥ 300 m margin`);
palOk.sort(byKey((c) => haversineM(c, PALISADES_ANCHOR)));
console.log("Top YES candidates (nearest anchor):");
for (const c of palOk.slice(0, 10)) console.log(`  ${fmt(c)} anchor_m=${Math.round(haversineM(c, PALISADES_ANCHOR))}`);

const p1 = palOk[0];
if (!p1) throw new Error("No candidate for property 1");
const p3 = palOk.find((c) => haversineM(c, p1) >= 1_500);
if (!p3) throw new Error("No candidate for property 3");

const west = scan(WESTSIDE);
const westOk = west.filter((c) => !c.inside && c.distance_m >= 3_000 && c.distance_m <= 6_000);
console.log(`Westside window: ${west.length} grid points, ${westOk.length} outside at 3–6 km`);
westOk.sort(byKey((c) => Math.abs(c.distance_m - 4_000)));
console.log("Top NO candidates (distance nearest 4 km):");
for (const c of westOk.slice(0, 10)) console.log(`  ${fmt(c)}`);
const p2 = westOk[0];
if (!p2) throw new Error("No candidate for property 2");

const chosen = [
  { property_id: 1, label: "Palisades · Home #1042", c: p1, expected: "YES" as const },
  { property_id: 2, label: "Westside · Home #2210", c: p2, expected: "NO" as const },
  { property_id: 3, label: "Palisades · Home #1187", c: p3, expected: "YES" as const },
].map(({ property_id, label, c, expected }) => {
  // Re-evaluate the exact integers that will be registered on-chain.
  const r = evaluate(geometry, { lat_e6: c.lat_e6, lon_e6: c.lon_e6, trigger_distance_m: TRIGGER });
  const ok = expected === "YES" ? r.inside && r.distance_m >= 300 : !r.inside && r.distance_m >= 2_000;
  if (!ok || r.triggered !== (expected === "YES")) throw new Error(`Property ${property_id} fails its margin`);
  return {
    property_id,
    label,
    lat_e6: c.lat_e6,
    lon_e6: c.lon_e6,
    scenario_id: SCENARIO_PALISADES_2025,
    trigger_distance_m: TRIGGER,
    expected,
    distance_m: r.distance_m,
    inside: r.inside,
  };
});

console.log("Selected:");
for (const p of chosen) {
  console.log(`  ${p.property_id} ${p.label}: lat_e6=${p.lat_e6} lon_e6=${p.lon_e6} inside=${p.inside} distance_m=${p.distance_m} expected=${p.expected}`);
}
console.log(`  property 1 ↔ 3 separation: ${Math.round(haversineM(p1, p3))} m`);

if (process.argv.includes("--write")) {
  writeFileSync(join(dataDir, "properties.json"), JSON.stringify(chosen, null, 2) + "\n");
  console.log("wrote data/properties.json");
}
