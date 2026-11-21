// Node-only helpers (import from "@metrex/geo/node"). Uses `fs`; keep out of browser bundles.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { getScenario, type ScenarioEntry, type ScenarioRegistry } from "@metrex/shared";
import type { MultiPolygon } from "geojson";
import { sha256Hex } from "./canonical";
import { assertHazardDataset, type HazardDataset } from "./hazard";

export interface LoadedScenario {
  scenario: ScenarioEntry;
  geometry: MultiPolygon;
}

/** Read `<dataDir>/scenarios.json`. */
export function loadScenarioRegistry(dataDir: string): ScenarioRegistry {
  return JSON.parse(readFileSync(join(dataDir, "scenarios.json"), "utf8")) as ScenarioRegistry;
}

/**
 * Load the normalized footprint for `scenarioId`. Refuses unknown scenario IDs, file
 * names that escape `dataDir`, SHA-256 mismatches against the registry, and files that
 * are not a FeatureCollection with exactly one MultiPolygon feature.
 */
export function loadScenarioGeometry(
  registry: ScenarioRegistry,
  scenarioId: number,
  dataDir: string,
): LoadedScenario {
  const scenario = getScenario(registry, scenarioId);
  if (basename(scenario.file) !== scenario.file) {
    throw new Error(`Scenario ${scenarioId} file must be a bare file name in data/`);
  }
  const bytes = readFileSync(join(dataDir, scenario.file));
  const actual = sha256Hex(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (actual !== scenario.sha256.toLowerCase()) {
    throw new Error(
      `Dataset hash mismatch for scenario ${scenarioId}: expected ${scenario.sha256}, got ${actual}`,
    );
  }
  const fc = JSON.parse(bytes.toString("utf8")) as {
    type?: unknown;
    features?: Array<{ type?: unknown; geometry?: { type?: unknown } }>;
  };
  const feature = fc.features?.[0];
  if (
    fc.type !== "FeatureCollection" ||
    fc.features?.length !== 1 ||
    feature?.type !== "Feature" ||
    feature.geometry?.type !== "MultiPolygon"
  ) {
    throw new Error(`Scenario ${scenarioId} file is not a single-MultiPolygon FeatureCollection`);
  }
  return { scenario, geometry: feature.geometry as MultiPolygon };
}

// ---------- Multi-peril (docs/spec-multiperil.md §4) ----------

/**
 * Load the hazard dataset for `scenarioId` (scenarios 2+). Same refusals as the wildfire loader:
 * unknown IDs, paths escaping `dataDir`, SHA-256 mismatch, and any structure or rule
 * `assertHazardDataset` rejects.
 */
export function loadHazardDataset(
  registry: ScenarioRegistry,
  scenarioId: number,
  dataDir: string,
): { scenario: ScenarioEntry; dataset: HazardDataset } {
  const scenario = getScenario(registry, scenarioId);
  if (basename(scenario.file) !== scenario.file) {
    throw new Error(`Scenario ${scenarioId} file must be a bare file name in data/`);
  }
  const bytes = readFileSync(join(dataDir, scenario.file));
  const actual = sha256Hex(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (actual !== scenario.sha256.toLowerCase()) {
    throw new Error(`Dataset hash mismatch for scenario ${scenarioId}: expected ${scenario.sha256}, got ${actual}`);
  }
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  assertHazardDataset(parsed);
  if (parsed.metrex.name !== scenario.name) {
    throw new Error(`Scenario ${scenarioId} file declares ${parsed.metrex.name}, registry says ${scenario.name}`);
  }
  return { scenario, dataset: parsed };
}
