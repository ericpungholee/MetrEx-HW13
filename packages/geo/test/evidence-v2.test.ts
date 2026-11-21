// spec-v2 §9.3 evidence v2: canonical bytes, `round` and `version: 2`, v1 builder unchanged.
import type { MultiPolygon } from "geojson";
import type { ScenarioEntry } from "@metrex/shared";
import { describe, expect, it } from "vitest";
import { buildEvidence, buildEvidenceV2, sha256Hex } from "../src";

const scenario: ScenarioEntry = {
  scenarioId: 1,
  name: "synthetic",
  title: "Synthetic square",
  file: "synthetic.geojson",
  sha256: "00".repeat(32),
  source: "test",
  retrieved: "2026-11-21",
};
// Synthetic geometry (not a real place): a 0.02° square around (0, 0).
const geometry: MultiPolygon = {
  type: "MultiPolygon",
  coordinates: [[[[-0.01, -0.01], [0.01, -0.01], [0.01, 0.01], [-0.01, 0.01], [-0.01, -0.01]]]],
};
const base = {
  market: "BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko",
  programId: "BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko",
  property: { id: 1, lat_e6: 0, lon_e6: 0 },
  scenarioId: 1,
  triggerDistanceM: 500,
  scenario,
  geometry,
};
const ROUND = "AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X";

describe("evidence v2 (§9.3)", () => {
  it("adds round and version 2 to the v1 record, canonical and hashed", () => {
    const v2 = buildEvidenceV2({ ...base, round: ROUND });
    expect(v2.record.version).toBe(2);
    expect(v2.record.round).toBe(ROUND);
    expect(v2.record.triggered).toBe(true);
    expect(v2.canonical).toMatch(/^\{"computed":\{"distance_m":\d+,"inside":true\},"dataset":/);
    expect(v2.canonical).toContain(`"round":"${ROUND}","scenario_id":1`);
    expect(v2.canonical.endsWith(',"triggered":true,"version":2}')).toBe(true);
    expect(sha256Hex(new TextEncoder().encode(v2.canonical))).toBe(v2.hashHex);
  });
  it("leaves the v1 builder unchanged and differs from it", () => {
    const v1 = buildEvidence(base);
    expect(v1.record.version).toBe(1);
    expect("round" in v1.record).toBe(false);
    expect(buildEvidenceV2({ ...base, round: ROUND }).hashHex).not.toBe(v1.hashHex);
  });
  it("rejects a non-base58 round", () => {
    expect(() => buildEvidenceV2({ ...base, round: "not a key" })).toThrow();
  });
});
