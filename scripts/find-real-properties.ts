// Select the four catalog properties from REAL OpenStreetMap address points (docs/spec-multiperil.md §3).
//
//   pnpm tsx scripts/find-real-properties.ts --fetch   # download raw OSM address points (Overpass API)
//   pnpm tsx scripts/find-real-properties.ts           # select offline from the saved raw files
//   pnpm tsx scripts/find-real-properties.ts --write   # also write data/market-properties.json
//
// Raw responses are saved under data/raw/osm-addresses/ and pinned by SHA-256 in
// data/DATASET-hazards.md, so the selection is reproducible offline. Each candidate is a residential
// address point (addr:housenumber + addr:street, no shop/amenity/office/tourism/craft tag, building
// classification from a residential building tag or a verified county parcel). It is re-evaluated exactly as the oracle will, at its integer
// micro-degree coordinates. No damage-inspection (DINS) or other damage data is used: addresses with
// OSM damage:* or lifecycle (destroyed:, razed:, …) tags are excluded, and outcomes come only from
// the hazard datasets, which measure proximity or intensity, not damage.
//
// Margins (same as the earlier lattice selections):
//   7 wildfire    YES  inside the final Palisades footprint, not in a hole (≥ 500 m from flipping to
//                      NO, since the trigger extends 500 m past every ring). The lattice picks also
//                      required ≥ 300 m from every ring; no undamaged-tagged OSM home meets that.
//   8 hurricane   NO   outside every Sept 2017 64-kt swath by ≥ 10 km
//   9 earthquake  YES  nearest-node MMI ≥ 8.1 and node ≤ 1 km, at an assessor-confirmed dwelling
//   6 tornado     YES  ≤ 150 m from an EF2+ centerline (trigger 500 m)
// Within each window the qualifying address nearest the anchor wins; ties break on OSM type and id.
// The label "<housenumber> <street>" must fit the 32-byte on-chain label.
//
// Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate, evaluateHazard, geodesicMeters, type IntensityGridDataset } from "@metrex/geo";
import { loadHazardDataset, loadScenarioGeometry, loadScenarioRegistry } from "@metrex/geo/node";

const DATA = join(__dirname, "..", "data");
const NAPA_PARCELS = join(DATA, "raw", "napa-residential-parcels.json");
const RAW = join(DATA, "raw", "osm-addresses");
const OVERPASS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
const registry = loadScenarioRegistry(DATA);

interface Area {
  key: string;
  propertyId: number;
  scenarioId: number;
  triggerDistanceM: number;
  /** Place line when the address has no addr:city; otherwise "<addr:city>, <state>". */
  place: string;
  state: string;
  /** south, west, north, east */
  bbox: [number, number, number, number];
  anchor: { lat: number; lon: number };
  expectTriggered: boolean;
  accept: (lat_e6: number, lon_e6: number) => { ok: boolean; computed: unknown; triggered: boolean };
}

const palisades = loadScenarioGeometry(registry, 1, DATA).geometry;
const hurricane = loadHazardDataset(registry, 2, DATA).dataset;
const quake = loadHazardDataset(registry, 3, DATA).dataset as IntensityGridDataset;
const tornado = loadHazardDataset(registry, 4, DATA).dataset;

const AREAS: Area[] = [
  {
    key: "pacific-palisades",
    propertyId: 7,
    scenarioId: 1,
    triggerDistanceM: 500,
    place: "Pacific Palisades, California", state: "California",
    bbox: [34.03, -118.57, 34.08, -118.5],
    anchor: { lat: 34.045, lon: -118.526 },
    expectTriggered: true,
    accept: (lat_e6, lon_e6) => {
      const r = evaluate(palisades, { lat_e6, lon_e6, trigger_distance_m: 500 });
      // Inside the footprint: the trigger reaches 500 m beyond every ring, so the point would have
      // to move ≥ 500 m to flip to NO. That is the margin.
      return { ok: r.triggered && r.inside, computed: r, triggered: r.triggered };
    },
  },
  {
    key: "miami",
    propertyId: 8,
    scenarioId: 2,
    triggerDistanceM: 0,
    place: "Miami, Florida", state: "Florida",
    bbox: [25.7, -80.3, 25.75, -80.26],
    anchor: { lat: 25.722, lon: -80.278 },
    expectTriggered: false,
    accept: (lat_e6, lon_e6) => {
      const r = evaluateHazard(hurricane, { lat_e6, lon_e6, trigger_distance_m: 0 });
      const ok = !r.triggered && "inside" in r.computed && r.computed.distance_m >= 10_000;
      return { ok, computed: r.computed, triggered: r.triggered };
    },
  },
  {
    key: "napa",
    propertyId: 9,
    scenarioId: 3,
    triggerDistanceM: 0,
    place: "Napa, California", state: "California",
    bbox: [38.21, -122.33, 38.27, -122.28],
    anchor: { lat: 38.25, lon: -122.295 },
    expectTriggered: true,
    accept: (lat_e6, lon_e6) => {
      let r;
      try {
        r = evaluateHazard(quake, { lat_e6, lon_e6, trigger_distance_m: 0 });
      } catch {
        return { ok: false, computed: null, triggered: false }; // not covered
      }
      if (!("mmi_x10" in r.computed) || r.computed.mmi_x10 < 81) return { ok: false, computed: r.computed, triggered: r.triggered };
      return { ok: r.triggered, computed: r.computed, triggered: r.triggered };
    },
  },
  {
    key: "johnston-des-moines",
    propertyId: 6,
    scenarioId: 4,
    triggerDistanceM: 500,
    place: "Des Moines area, Iowa", state: "Iowa",
    bbox: [41.68, -93.75, 41.72, -93.7],
    anchor: { lat: 41.7, lon: -93.73 },
    expectTriggered: true,
    accept: (lat_e6, lon_e6) => {
      const r = evaluateHazard(tornado, { lat_e6, lon_e6, trigger_distance_m: 500 });
      const ok = r.triggered && "distance_m" in r.computed && r.computed.distance_m <= 150;
      return { ok, computed: r.computed, triggered: r.triggered };
    },
  },
];

const NON_RESIDENTIAL = ["shop", "amenity", "office", "tourism", "craft", "leisure", "healthcare", "industrial", "name", "brand", "operator"];
const RESIDENTIAL_BUILDINGS = new Set(["house", "detached", "residential", "semidetached_house", "bungalow", "terrace", "apartments"]);
/** Tag key without an OSM lifecycle prefix (razed:, destroyed:, disused:, was:, …). */
const LIFECYCLE = /^(razed|destroyed|demolished|disused|abandoned|was|removed|ruins|construction|proposed):/;
const baseKey = (k: string) => k.replace(LIFECYCLE, "");
/**
 * Residential evidence comes from a residential building tag or the county assessor. Any non-residential tag, prefixed or not, disqualifies; `building=yes` is
 * ambiguous and excluded. Any damage or lifecycle tag (damage:*, destroyed:, razed:, …) also
 * disqualifies: those come from damage inspections, and no damage data may pick a property.
 */
function isResidential(t: Record<string, string>, verifiedParcel: boolean): boolean {
  const keys = Object.keys(t);
  if (keys.some((k) => k.startsWith("damage:") || LIFECYCLE.test(k))) return false;
  if (keys.some((k) => !k.startsWith("addr:") && NON_RESIDENTIAL.includes(baseKey(k)))) return false;
  const buildings = keys.filter((k) => baseKey(k) === "building").map((k) => t[k]!);
  return buildings.length ? buildings.every((b) => RESIDENTIAL_BUILDINGS.has(b)) : verifiedParcel;
}

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const query = ([s, w, n, e]: Area["bbox"]) =>
  `[out:json][timeout:120];(nwr["addr:housenumber"]["addr:street"](${s},${w},${n},${e}););out tags center;`;

async function fetchArea(a: Area): Promise<void> {
  let text: string | null = null;
  const errors: string[] = [];
  for (let attempt = 0; attempt < 3 && text === null; attempt++) {
    for (const url of OVERPASS) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "metrex-demo-data/1.0" },
          body: new URLSearchParams({ data: query(a.bbox) }).toString(),
        });
        if (res.ok) {
          text = await res.text();
          break;
        }
        errors.push(`${new URL(url).host} HTTP ${res.status}`);
      } catch (e) {
        errors.push(`${new URL(url).host} ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  if (text === null) throw new Error(`Overpass ${a.key}: ${errors.join("; ")}`);
  const parsed = JSON.parse(text) as { elements?: unknown[] };
  if (!Array.isArray(parsed.elements)) throw new Error(`Overpass ${a.key}: no elements`);
  mkdirSync(RAW, { recursive: true });
  writeFileSync(join(RAW, `${a.key}.json`), text);
  console.log(`fetched ${a.key}: ${parsed.elements.length} elements, sha256 ${createHash("sha256").update(text).digest("hex")}`);
}

const osmHashes: Record<string, string> = {
  "johnston-des-moines": "8fef59fc75f25a2f525d49eba0f4826348dc29667475b294e9bc24f2e0fbbd4e",
  "miami": "e05baca343ea6337c887ab7d1a521c65709f665296ae587098b4ce351f815ddd",
  "napa": "a097e53a065c3075b94538a635076ee0213dae4bea10a20faf49906dd430f7de",
  "pacific-palisades": "dc754f97e4b78eab8dc7e564242e01592d04d89def4e86868bf4f4cd595182ee",
};

const parcelKey = (address: string) => address.trim().toUpperCase().replace(/ COURT$/, " CT").replace(/ CIRCLE$/, " CIR").replace(/ ROAD$/, " RD").replace(/ LANE$/, " LN");
function napaResidentialAddresses(): Set<string> {
  const raw = readFileSync(NAPA_PARCELS);
  if (createHash("sha256").update(raw).digest("hex") !== "3eeebc23a5109c8587c9b78724134dce17a51d8867b39808a9790b6d0d6f3bda") {
    throw new Error("Napa residential parcel pin mismatch");
  }
  const response = JSON.parse(raw.toString("utf8")) as {
    features: { attributes: { StreetAddr: string; NumUnitsResidential: number | null; DwellingUnitsCount: number | null } }[];
  };
  return new Set(response.features.flatMap(({ attributes: a }) =>
    (a.NumUnitsResidential ?? 0) > 0 || (a.DwellingUnitsCount ?? 0) > 0 ? [parcelKey(a.StreetAddr)] : [],
  ));
}

const e6 = (v: number) => Math.round(v * 1e6);
const bytes = (s: string) => new TextEncoder().encode(s).length;

async function main(): Promise<void> {
  if (process.argv.includes("--fetch")) {
    for (const a of AREAS) {
      if (existsSync(join(RAW, `${a.key}.json`)) && !process.argv.includes("--refetch")) continue;
      await fetchArea(a);
      await new Promise((r) => setTimeout(r, 2_000)); // be polite to the public Overpass instance
    }
  }
  const napaAddresses = napaResidentialAddresses();
  const out: { property_id: number; label: string; lat_e6: number; lon_e6: number; scenario_id: number; trigger_distance_m: number; place: string; osm: string }[] = [];
  for (const a of AREAS) {
    const path = join(RAW, `${a.key}.json`);
    if (!existsSync(path)) throw new Error(`missing ${path}; run with --fetch`);
    const raw = readFileSync(path, "utf8");
    const sha = createHash("sha256").update(raw).digest("hex");
    if (sha !== osmHashes[a.key]) throw new Error(`OSM source pin mismatch: ${a.key} (${sha})`);
    const elements = (JSON.parse(raw) as { elements: OsmElement[] }).elements;
    let best: { el: OsmElement; label: string; lat_e6: number; lon_e6: number; dist: number; computed: unknown; triggered: boolean } | null = null;
    // Residential candidates, nearest the anchor first (ties on OSM type/id); the first that meets
    // the margin wins, so the expensive hazard evaluation runs only until then.
    const key = (x: OsmElement) => `${x.type}/${String(x.id).padStart(12, "0")}`;
    const candidates = elements
      .flatMap((el) => {
        const t = el.tags ?? {};
        const label = `${t["addr:housenumber"]} ${t["addr:street"]}`;
        if (!isResidential(t, a.key === "napa" && napaAddresses.has(parcelKey(label)))) return [];
        const pos = el.center ?? (el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : null);
        if (!pos) return [];
        if (bytes(label) > 32 || !/^\d+[A-Za-z]?$/.test(t["addr:housenumber"] ?? "")) return [];
        const lat_e6 = e6(pos.lat);
        const lon_e6 = e6(pos.lon);
        return [{ el, label, lat_e6, lon_e6, dist: geodesicMeters(lat_e6 / 1e6, lon_e6 / 1e6, a.anchor.lat, a.anchor.lon) }];
      })
      .sort((x, y) => x.dist - y.dist || (key(x.el) < key(y.el) ? -1 : 1));
    const considered = candidates.length;
    for (const c of candidates) {
      const r = a.accept(c.lat_e6, c.lon_e6);
      if (!r.ok) continue;
      best = { ...c, computed: r.computed, triggered: r.triggered };
      break;
    }
    if (!best) {
      const triggered = candidates.filter((c) => a.accept(c.lat_e6, c.lon_e6).triggered === a.expectTriggered).length;
      throw new Error(`${a.key}: no residential address meets the margin among ${considered} (${triggered} have the expected outcome)`);
    }
    if (best.triggered !== a.expectTriggered) throw new Error(`${a.key}: evaluates to ${best.triggered}`);
    console.log(
      `${a.propertyId} ${best.label} (${a.place})  ${best.el.type}/${best.el.id}  (${best.lat_e6 / 1e6}, ${best.lon_e6 / 1e6})  ` +
        `${best.triggered ? "YES" : "NO"}  ${JSON.stringify(best.computed)}  [${considered} residential candidates, raw sha256 ${sha.slice(0, 16)}…]`,
    );
    out.push({
      property_id: a.propertyId,
      label: best.label,
      lat_e6: best.lat_e6,
      lon_e6: best.lon_e6,
      scenario_id: a.scenarioId,
      trigger_distance_m: a.triggerDistanceM,
      place: best.el.tags?.["addr:city"] ? `${best.el.tags["addr:city"]}, ${a.state}` : a.place,
      osm: `${best.el.type}/${best.el.id}`,
    });
  }
  if (process.argv.includes("--write")) {
    writeFileSync(join(DATA, "market-properties.json"), JSON.stringify(out, null, 2) + "\n");
    console.log("wrote data/market-properties.json");
  }
}

main().catch((e: unknown) => {
  console.error(`find-real-properties failed: ${(e as Error).message}`);
  process.exit(1);
});
