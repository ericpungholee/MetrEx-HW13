// The ONE place that touches @metrex/geo (Workstream B, built in parallel).
//
// Agreed contract:
//   @metrex/geo:       buildEvidence({ market, programId, property: { id, lat_e6, lon_e6 },
//                        scenarioId, triggerDistanceM, scenario, geometry })
//                        → { record, canonical, hashHex, hashBytes }
//   @metrex/geo/node:  loadScenarioGeometry(registry, scenarioId, dataDir) → geometry
//
// Today @metrex/geo exports nothing, so `buildEvidence` is looked up on the namespace at
// runtime (a static import keeps tsx and Next.js bundling happy). Geometry is loaded here
// with the same contract (registry lookup + SHA-256 check of the normalized file) until
// @metrex/geo/node exists. When B lands, change only this file:
//   import { buildEvidence } from "@metrex/geo";
//   import { loadScenarioGeometry } from "@metrex/geo/node";

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import * as geo from "@metrex/geo";
import { getScenario, type EvidenceRecord, type ScenarioEntry, type ScenarioRegistry } from "@metrex/shared";

export interface BuildEvidenceInput {
  market: string;
  programId: string;
  property: { id: number; lat_e6: number; lon_e6: number };
  scenarioId: number;
  triggerDistanceM: number;
  scenario: ScenarioEntry;
  geometry: unknown;
}

export interface BuiltEvidence {
  record: EvidenceRecord;
  /** Canonical JSON string (§8.4). Written byte-for-byte to data/evidence/<market>.json. */
  canonical: string;
  hashHex: string;
  hashBytes: Uint8Array;
}

export interface GeoAdapter {
  loadScenarioGeometry(registry: ScenarioRegistry, scenarioId: number, dataDir: string): Promise<unknown>;
  buildEvidence(input: BuildEvidenceInput): Promise<BuiltEvidence>;
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error("buildEvidence returned hashBytes in an unknown form");
}

/** Registry lookup + SHA-256 check; refuses unknown scenarios and tampered files (§8.1). */
export async function loadScenarioGeometryLocal(
  registry: ScenarioRegistry,
  scenarioId: number,
  dir: string,
): Promise<unknown> {
  const entry = getScenario(registry, scenarioId);
  const path = normalize(join(dir, entry.file));
  if (!path.startsWith(normalize(dir) + sep)) throw new Error(`Scenario file escapes data dir: ${entry.file}`);
  const bytes = await readFile(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== entry.sha256.toLowerCase()) {
    throw new Error(`Dataset ${entry.file} SHA-256 ${sha} does not match registry ${entry.sha256}`);
  }
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

type BuildFn = (input: BuildEvidenceInput) => unknown;

/** Default adapter over the real @metrex/geo package. */
export const realGeo: GeoAdapter = {
  loadScenarioGeometry: loadScenarioGeometryLocal,
  async buildEvidence(input) {
    const build = (geo as Record<string, unknown>)["buildEvidence"];
    if (typeof build !== "function") {
      throw new Error("@metrex/geo does not export buildEvidence() yet (Workstream B); cannot resolve");
    }
    const out = (await (build as BuildFn)(input)) as Partial<BuiltEvidence> | undefined;
    if (!out || typeof out.canonical !== "string" || typeof out.hashHex !== "string" || !out.record) {
      throw new Error("buildEvidence returned an unexpected shape");
    }
    return { record: out.record, canonical: out.canonical, hashHex: out.hashHex, hashBytes: toBytes(out.hashBytes) };
  },
};
