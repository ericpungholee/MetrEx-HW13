import { buildEvidence, type BuildEvidenceInput, type BuiltEvidence, type FootprintGeometry } from "@metrex/geo";
import { loadScenarioGeometry } from "@metrex/geo/node";
import type { ScenarioRegistry } from "@metrex/shared";

export interface GeoAdapter {
  loadScenarioGeometry(registry: ScenarioRegistry, scenarioId: number, dataDir: string): Promise<FootprintGeometry>;
  buildEvidence(input: BuildEvidenceInput): Promise<BuiltEvidence>;
}

export const realGeo: GeoAdapter = {
  async loadScenarioGeometry(registry, scenarioId, dir) {
    return loadScenarioGeometry(registry, scenarioId, dir).geometry;
  },
  async buildEvidence(input) {
    return buildEvidence(input);
  },
};
