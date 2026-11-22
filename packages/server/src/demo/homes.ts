// Home pool (docs/spec-multiperil.md §7.7): real residential addresses in each hazard's area,
// selected offline by scripts/find-real-properties.ts from pinned OSM data. A homeowner lists one
// of these; nothing here comes from user input or a live lookup.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_PROPERTY_BASE, catalogByScenario } from "@metrex/exchange";
import { dataDir } from "../env";

export interface HomeRow {
  property_id: number;
  label: string;
  lat_e6: number;
  lon_e6: number;
  scenario_id: number;
  trigger_distance_m: number;
  place: string;
  osm: string;
}

let cache: { rows: HomeRow[]; byId: Map<number, HomeRow> } | undefined;

function load() {
  if (!cache) {
    const rows = JSON.parse(readFileSync(join(dataDir(), "home-addresses.json"), "utf8")) as HomeRow[];
    for (const r of rows) {
      if (r.property_id < HOME_PROPERTY_BASE || r.property_id > 65_535) throw new Error(`home ${r.property_id}: id outside the home range`);
      if (!catalogByScenario(r.scenario_id)) throw new Error(`home ${r.property_id}: unknown scenario ${r.scenario_id}`);
    }
    cache = { rows, byId: new Map(rows.map((r) => [r.property_id, r])) };
  }
  return cache;
}

export const homesOfScenario = (scenarioId: number): HomeRow[] => load().rows.filter((r) => r.scenario_id === scenarioId);
export const homeById = (propertyId: number): HomeRow | undefined => load().byId.get(propertyId);
