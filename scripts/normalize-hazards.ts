// Normalize the raw multi-peril datasets (docs/spec-multiperil.md §4, data/DATASET-hazards.md).
// Idempotent and deterministic. No network access.
//
//   pnpm tsx scripts/normalize-hazards.ts            # write data/<scenario files> and print hashes
//   pnpm tsx scripts/normalize-hazards.ts --check    # refuse if any output would change
//
// Inputs (fingerprinted below; the script refuses a raw file whose SHA-256 differs):
//   data/raw/nhc-2017/al1{1..5}2017_windswath.{shp,dbf}   NHC best-track wind swaths, 2017 Atlantic
//   data/raw/nhc-2017/al112017_radii.{shp,dbf}             Irma wind radii (pre-window check)
//   data/raw/usgs-napa-2014/grid.xml                       USGS ShakeMap grid, South Napa (not committed; 10 MB)
//   data/raw/nws-dat-iowa-2024-05-ef2.geojson              NWS Damage Assessment Toolkit EF2+ tracks
//
// Every output pins its rule (hazard, method, threshold, coverage window) inside the hashed bytes.
// Coordinates and intensities are copied exactly; nothing is simplified, buffered or interpolated.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as shp from "shapefile";
// Local GeoJSON shapes (the scripts package has no @types/geojson).
type Position = number[];
type Polygon = { type: "Polygon"; coordinates: Position[][] };
type MultiPolygon = { type: "MultiPolygon"; coordinates: Position[][][] };
import {
  assertHazardDataset,
  sha256Hex,
  type FootprintDataset,
  type FootprintFeature,
  type HazardMeta,
  type IntensityGridDataset,
  type TrackDataset,
  type TrackFeature,
} from "@metrex/geo";

const DATA = join(__dirname, "..", "data");
const RAW = join(DATA, "raw");
const CHECK = process.argv.includes("--check");

const RAW_SHA256: Record<string, string> = {
  "nhc-2017/al112017_windswath.shp": "7ecc3350b758d37c50255dcb825ec31456ff201ea31db31f8170834817abfd6a",
  "nhc-2017/al112017_windswath.dbf": "73d63b2ba26bc909e06cb08ad5bac788a43ccdbd4cf39269d47b21714a93607a",
  "nhc-2017/al122017_windswath.shp": "463146a7599a4441a0c6d3d040983387f4cc5819442e2bc6feaba17df7bd6405",
  "nhc-2017/al122017_windswath.dbf": "7a59088f431c6219dbbe4c90ba14cfe20ae49bb48edafb42c2f89460a016f74a",
  "nhc-2017/al132017_windswath.shp": "3a4682a22972d6fcb5f63b6c431472f590b7fece2244d40e577b63cfc61fbeeb",
  "nhc-2017/al132017_windswath.dbf": "48897efc57828bd37dfef93f4f1357c46bb0fa139f685a544f192aa26d8b0c67",
  "nhc-2017/al142017_windswath.shp": "7e6220f46c8cf9f1f04171f58ff884d181d338ab8610b016de9eaf06ded90ab5",
  "nhc-2017/al142017_windswath.dbf": "50e360552179726eb1c785e96ceac6816590bdb4e3c1241952dbc0f68df759a6",
  "nhc-2017/al152017_windswath.shp": "70cc01395decf5517f59fbb8761b878e360210d2127e4cee95a7a1c8e9849df0",
  "nhc-2017/al152017_windswath.dbf": "2cabb80095f8b91f2cf4b7ca063d9c055be78b6c091273d07d76d9158cfe75fc",
  "nhc-2017/al112017_radii.shp": "b2bba6b7353964bf7cad0baf8a40c718297471e219e761a487ec01fab7ef1efd",
  "nhc-2017/al112017_radii.dbf": "62d68e668c294795028492a1db6309a749571851651f0b713dccbda6ab987be0",
  "usgs-napa-2014/grid.xml": "f78b652c0de85368d43dc80c43c394973c6e5462c46e331d7df033a5e22c06ec",
  "nws-dat-iowa-2024-05-ef2.geojson": "e9e3cc43fc482461099496442d6984335283b506d7358e11f698822e599a0d1d",
};

function fail(msg: string): never {
  throw new Error(`normalize-hazards: ${msg}`);
}

function readRaw(rel: string): Buffer {
  const path = join(RAW, rel);
  if (!existsSync(path)) {
    fail(`missing ${path}. See data/DATASET-hazards.md for the exact download URL.`);
  }
  const bytes = readFileSync(path);
  const got = sha256Hex(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (got !== RAW_SHA256[rel]) fail(`${rel} SHA-256 ${got} != expected ${RAW_SHA256[rel]}`);
  return bytes;
}

/** "2017083106" → "2017-08-31T06:00:00Z". */
function dtgToIso(dtg: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})$/.exec(dtg);
  if (!m) fail(`bad DTG ${dtg}`);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:00:00Z`;
}

function writeOut(file: string, value: unknown): string {
  assertHazardDataset(value);
  const text = JSON.stringify(value) + "\n";
  const path = join(DATA, file);
  if (CHECK) {
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (existing !== text) fail(`${file} is out of date; run without --check`);
  } else {
    writeFileSync(path, text);
  }
  const hash = sha256Hex(new TextEncoder().encode(text));
  console.log(`${file}  ${text.length} bytes  sha256 ${hash}`);
  return hash;
}

// ---------- Hurricanes, September 2017 (scenario 2) ----------

const HURRICANE_WINDOW = { start: "2017-09-01T04:00:00Z", end: "2017-10-01T04:00:00Z", tz: "America/New_York" };
const STORMS: [string, string][] = [
  ["al112017", "Hurricane Irma"],
  ["al122017", "Hurricane Jose"],
  ["al132017", "Hurricane Katia"],
  ["al142017", "Hurricane Lee"],
  ["al152017", "Hurricane Maria"],
];

async function readShapes(base: string): Promise<{ properties: Record<string, unknown>; geometry: Polygon | MultiPolygon }[]> {
  const shpBytes = readRaw(`${base}.shp`);
  const dbfBytes = readRaw(`${base}.dbf`);
  const src = await shp.open(
    new Uint8Array(shpBytes),
    new Uint8Array(dbfBytes),
  );
  const out: { properties: Record<string, unknown>; geometry: Polygon | MultiPolygon }[] = [];
  for (;;) {
    const r = await src.read();
    if (r.done) break;
    const g = r.value.geometry;
    if (g.type !== "Polygon" && g.type !== "MultiPolygon") fail(`${base}: unexpected ${g.type}`);
    out.push({ properties: r.value.properties as Record<string, unknown>, geometry: g });
  }
  return out;
}

const asMulti = (g: Polygon | MultiPolygon): Position[][][] => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);

async function hurricanes(): Promise<string> {
  const ws = Date.parse(HURRICANE_WINDOW.start);
  const we = Date.parse(HURRICANE_WINDOW.end);
  const features: FootprintFeature[] = [];
  for (const [id, name] of STORMS) {
    const shapes = (await readShapes(`nhc-2017/${id}_windswath`)).filter((s) => s.properties.RADII === 64);
    for (const [i, s] of shapes.entries()) {
      if (s.properties.STORMID !== id) fail(`${id}: STORMID ${String(s.properties.STORMID)}`);
      const start = dtgToIso(String(s.properties.STARTDTG));
      const end = dtgToIso(String(s.properties.ENDDTG));
      // Keep a swath piece only if its 64-kt period overlaps the coverage window.
      if (!(Date.parse(start) < we && Date.parse(end) > ws)) continue;
      features.push({
        type: "Feature",
        properties: { id: shapes.length > 1 ? `${id}-${i + 1}` : id, label: `${name} 64-kt swath`, start, end },
        geometry: { type: "MultiPolygon", coordinates: asMulti(s.geometry) },
      });
    }
  }
  if (features.length === 0) fail("no hurricane swaths in the window");

  // Irma's 64-kt period starts 2017-08-31 06Z, before the window. Prove that every Irma 64-kt
  // radius up to the first in-window synoptic time lies east of 60°W (Florida is west of 79°W), so
  // the pre-window part of the swath cannot reach any covered property.
  const radii = await readShapes("nhc-2017/al112017_radii");
  const firstInWindow = "2017090106";
  let checked = 0;
  for (const r of radii) {
    if (r.properties.RADII !== 64 || String(r.properties.SYNOPTIME) > firstInWindow) continue;
    for (const poly of asMulti(r.geometry)) for (const ring of poly) for (const [lon] of ring) {
      if (!(lon! > -60)) fail(`Irma pre-window 64-kt radius at ${String(r.properties.SYNOPTIME)} reaches ${lon}`);
    }
    checked++;
  }
  if (checked === 0) fail("no pre-window Irma radii found");

  const meta: HazardMeta = {
    version: 1,
    name: "atlantic-hurricanes-2017-09",
    rule: {
      hazard: "hurricane",
      method: "inside_footprint",
      threshold: "Inside a 64-kt (hurricane-force, 1-minute sustained) best-track wind swath",
      threshold_x10: 0,
      coverage_start: HURRICANE_WINDOW.start,
      coverage_end: HURRICANE_WINDOW.end,
      timezone: HURRICANE_WINDOW.tz,
    },
    sources: STORMS.map(([id]) => `https://www.nhc.noaa.gov/gis/best_track/${id}_best_track.zip`),
  };
  const ds: FootprintDataset = { type: "FeatureCollection", metrex: meta, features };
  return writeOut("atlantic-hurricanes-2017-09.geojson", ds);
}

// ---------- Earthquake, August 2014 (scenario 3) ----------

const QUAKE_WINDOW = { start: "2014-08-01T07:00:00Z", end: "2014-09-01T07:00:00Z", tz: "America/Los_Angeles" };
const QUAKE_CROP = { latMin: 38.05, latMax: 38.45, lonMin: -122.55, lonMax: -122.05 };

function decimalToInt(s: string, places: number): number {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) fail(`not a decimal: ${s}`);
  const frac = m[3] ?? "";
  if (frac.length > places) fail(`${s} has more than ${places} decimals`);
  const v = Number(m[2]! + frac.padEnd(places, "0"));
  return m[1] === "-" ? -v : v;
}

function attr(xml: string, tag: string, name: string): string {
  const el = new RegExp(`<${tag}\\b[^>]*>`).exec(xml)?.[0];
  const v = el && new RegExp(`\\b${name}="([^"]*)"`).exec(el)?.[1];
  if (v === undefined) fail(`grid.xml: missing ${tag}@${name}`);
  return v;
}

function earthquake(): string {
  const xml = readRaw("usgs-napa-2014/grid.xml").toString("utf8");
  if (attr(xml, "shakemap_grid", "event_id") !== "nc72282711") fail("unexpected event_id");
  if (attr(xml, "shakemap_grid", "shakemap_originator") !== "atlas") fail("unexpected originator");
  if (attr(xml, "shakemap_grid", "shakemap_version") !== "2") fail("unexpected version");
  if (attr(xml, "shakemap_grid", "shakemap_event_type") !== "ACTUAL") fail("not an ACTUAL event");
  const time = attr(xml, "event", "event_timestamp") + "Z";
  const t = Date.parse(time);
  if (!(t >= Date.parse(QUAKE_WINDOW.start) && t < Date.parse(QUAKE_WINDOW.end))) fail(`event ${time} outside window`);
  const fields = [...xml.matchAll(/<grid_field index="(\d+)" name="([A-Z0-9]+)"/g)].map((m) => m[2]);
  if (fields[0] !== "LON" || fields[1] !== "LAT" || fields[2] !== "MMI") fail(`unexpected grid fields ${fields.join(",")}`);

  const body = xml.split("<grid_data>")[1]?.split("</grid_data>")[0];
  if (!body) fail("grid.xml: no grid_data");
  const nodes: [number, number, number][] = [];
  let total = 0;
  for (const line of body.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3 || cols[0] === "") continue;
    total++;
    const lon = Number(cols[0]);
    const lat = Number(cols[1]);
    if (lat < QUAKE_CROP.latMin || lat > QUAKE_CROP.latMax || lon < QUAKE_CROP.lonMin || lon > QUAKE_CROP.lonMax) continue;
    nodes.push([decimalToInt(cols[0]!, 4), decimalToInt(cols[1]!, 4), decimalToInt(cols[2]!, 1)]);
  }
  const nlon = Number(attr(xml, "grid_specification", "nlon"));
  const nlat = Number(attr(xml, "grid_specification", "nlat"));
  if (total !== nlon * nlat) fail(`grid has ${total} nodes, header says ${nlon}×${nlat}`);

  const ds: IntensityGridDataset = {
    type: "MetrexIntensityGrid",
    metrex: {
      version: 1,
      name: "south-napa-2014-08",
      rule: {
        hazard: "earthquake",
        method: "nearest_node_intensity",
        threshold: "Modified Mercalli Intensity VIII (8.0) or higher at the nearest ShakeMap grid node",
        threshold_x10: 80,
        coverage_start: QUAKE_WINDOW.start,
        coverage_end: QUAKE_WINDOW.end,
        timezone: QUAKE_WINDOW.tz,
      },
      sources: [
        "https://earthquake.usgs.gov/product/shakemap/nc72282711/atlas/1624995941193/download/grid.xml",
        "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2014-07-31&endtime=2014-09-02&latitude=38.225&longitude=-122.308&maxradiuskm=150&minmagnitude=4",
      ],
    },
    event: {
      id: "nc72282711",
      label: `M${attr(xml, "event", "magnitude")} ${attr(xml, "event", "event_description")}`,
      time,
      magnitude_x10: decimalToInt(attr(xml, "event", "magnitude"), 1),
    },
    max_node_distance_m: 1000,
    nodes,
  };
  return writeOut("south-napa-2014-08.json", ds);
}

// ---------- Tornadoes, May 2024 (scenario 4) ----------

const TORNADO_WINDOW = { start: "2024-05-01T05:00:00Z", end: "2024-06-01T05:00:00Z", tz: "America/Chicago" };

interface DatFeature {
  properties: { objectid: number; wfo: string; efscale: string; efnum: number; starttime: number; endtime: number | null };
  geometry: { type: string; coordinates: Position[] };
}

function tornadoes(): string {
  const raw = JSON.parse(readRaw("nws-dat-iowa-2024-05-ef2.geojson").toString("utf8")) as { features: DatFeature[] };
  const ws = Date.parse(TORNADO_WINDOW.start);
  const we = Date.parse(TORNADO_WINDOW.end);
  const features: TrackFeature[] = raw.features
    .filter((f) => f.properties.efnum >= 2 && f.properties.starttime >= ws && f.properties.starttime < we)
    .sort((a, b) => a.properties.objectid - b.properties.objectid)
    .map((f) => {
      if (f.geometry.type !== "LineString") fail(`DAT ${f.properties.objectid}: ${f.geometry.type}`);
      const start = new Date(f.properties.starttime).toISOString();
      const end = new Date(f.properties.endtime ?? f.properties.starttime).toISOString();
      return {
        type: "Feature",
        properties: {
          id: `DAT-${f.properties.objectid}`,
          label: `${f.properties.efscale} tornado (NWS ${f.properties.wfo})`,
          start,
          end,
        },
        geometry: { type: "MultiLineString", coordinates: [f.geometry.coordinates] },
      };
    });
  if (features.length === 0) fail("no EF2+ tracks in the window");
  const ds: TrackDataset = {
    type: "FeatureCollection",
    metrex: {
      version: 1,
      name: "central-iowa-tornadoes-2024-05",
      rule: {
        hazard: "tornado",
        method: "track_proximity",
        threshold: "Surveyed centerline of an EF2-or-stronger tornado track within the market's trigger distance",
        threshold_x10: 0,
        coverage_start: TORNADO_WINDOW.start,
        coverage_end: TORNADO_WINDOW.end,
        timezone: TORNADO_WINDOW.tz,
      },
      sources: [
        "https://services.dat.noaa.gov/arcgis/rest/services/nws_damageassessmenttoolkit/DamageViewer/FeatureServer/1/query " +
          "(efnum >= 2, stormdate 2024-04-30..2024-06-02, envelope -94.8,40.9,-92.4,42.6, outSR 4326)",
      ],
    },
    features,
  };
  return writeOut("central-iowa-tornadoes-2024-05.geojson", ds);
}

async function main(): Promise<void> {
  await hurricanes();
  earthquake();
  tornadoes();
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
