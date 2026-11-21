// Scenario registry type for data/scenarios.json (spec §8.1). FROZEN after Gate 0.
// The oracle loads the dataset by `market.scenario_id` and refuses unknown IDs.

export interface ScenarioEntry {
  /** Matches `Property.scenario_id` / `Market.scenario_id`. */
  scenarioId: number;
  /** Short dataset name used in evidence, e.g. "palisades-2025". */
  name: string;
  /** Human title, e.g. "Palisades Fire, January 2025". */
  title: string;
  /** Normalized GeoJSON path relative to the repo's data/ directory. */
  file: string;
  /** Lowercase hex SHA-256 of the normalized file (`dataset_sha256`). */
  sha256: string;
  /** Authoritative source URL of the raw perimeter. */
  source: string;
  /** Retrieval date of the raw file, YYYY-MM-DD. */
  retrieved: string;
}

/** Shape of data/scenarios.json: keyed by the decimal scenario ID. */
export type ScenarioRegistry = Record<string, ScenarioEntry>;

export function getScenario(registry: ScenarioRegistry, scenarioId: number): ScenarioEntry {
  const entry = registry[String(scenarioId)];
  if (!entry || entry.scenarioId !== scenarioId) {
    throw new Error(`Unknown scenario_id ${scenarioId}`);
  }
  return entry;
}
