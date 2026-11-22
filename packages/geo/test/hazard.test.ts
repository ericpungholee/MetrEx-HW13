// Multi-peril datasets and evidence v3 (docs/spec-multiperil.md §4–§5), on the real committed data.
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildEvidenceV3, canonicalize, evaluate, evaluateHazard, sha256Hex, type HazardDataset } from "../src";
import { loadHazardDataset, loadScenarioGeometry, loadScenarioRegistry } from "../src/node";

const DATA_DIR = join(__dirname, "..", "..", "..", "data");
const registry = loadScenarioRegistry(DATA_DIR);
const properties = JSON.parse(readFileSync(join(DATA_DIR, "market-properties.json"), "utf8")) as {
  property_id: number;
  lat_e6: number;
  lon_e6: number;
  scenario_id: number;
  trigger_distance_m: number;
}[];
const prop = (id: number) => properties.find((p) => p.property_id === id)!;
const load = (s: number): HazardDataset => loadHazardDataset(registry, s, DATA_DIR).dataset;

const KEY = "11111111111111111111111111111111";
const MARKET = "So11111111111111111111111111111111111111112";

describe("hazard datasets", () => {
  it("pin hazard, method, threshold and a calendar-month coverage window inside the hashed file", () => {
    const expect_ = {
      2: ["hurricane", "inside_footprint", "2017-09-01T04:00:00Z", "2017-10-01T04:00:00Z"],
      3: ["earthquake", "nearest_node_intensity", "2014-08-01T07:00:00Z", "2014-09-01T07:00:00Z"],
      4: ["tornado", "track_proximity", "2024-05-01T05:00:00Z", "2024-06-01T05:00:00Z"],
    } as const;
    for (const [s, [hazard, method, start, end]] of Object.entries(expect_)) {
      const r = load(Number(s)).metrex.rule;
      expect([r.hazard, r.method, r.coverage_start, r.coverage_end]).toEqual([hazard, method, start, end]);
    }
    expect(load(3).metrex.rule.threshold_x10).toBe(80);
  });

  it("hurricane swaths are every Sept 2017 Atlantic 64-kt swath piece", () => {
    const d = load(2);
    expect(d.type).toBe("FeatureCollection");
    const ids = (d as Extract<HazardDataset, { type: "FeatureCollection" }>).features.map((f) => f.properties.id);
    expect(ids).toEqual(["al112017", "al122017-1", "al122017-2", "al132017", "al142017", "al152017"]);
  });

  it("tornado tracks are EF2+ only, all on 2024-05-21", () => {
    const d = load(4) as Extract<HazardDataset, { type: "FeatureCollection" }>;
    expect(d.features.length).toBe(4);
    for (const f of d.features) {
      expect(f.properties.label).toMatch(/^EF[2-5] /);
      expect(f.properties.start.startsWith("2024-05-21")).toBe(true);
    }
  });

  it("refuses a dataset whose bytes differ from the registry hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrex-hazard-"));
    copyFileSync(join(DATA_DIR, "scenarios.json"), join(dir, "scenarios.json"));
    const file = registry["4"]!.file;
    writeFileSync(join(dir, file), readFileSync(join(DATA_DIR, file), "utf8").replace("EF2", "EF3"));
    expect(() => loadHazardDataset(loadScenarioRegistry(dir), 4, dir)).toThrow(/hash mismatch/);
  });
});

describe("catalog properties: real OSM addresses (margins, §3)", () => {
  it("#7 16185 Sunset Boulevard is inside the final Palisades footprint: YES", () => {
    const { geometry } = loadScenarioGeometry(registry, 1, DATA_DIR);
    const r = evaluate(geometry, prop(7));
    expect(r.triggered).toBe(true);
    expect(r.inside).toBe(true);
  });

  it("#8 4835 University Drive (Coral Gables) is far outside every hurricane-force swath: NO", () => {
    const p = prop(8);
    const r = evaluateHazard(load(2), p);
    expect(r.triggered).toBe(false);
    expect("inside" in r.computed && r.computed.distance_m).toBeGreaterThanOrEqual(10_000);
  });

  it("#9 214 Auberge Path (Napa) reached MMI VIII at the nearest ShakeMap node: YES", () => {
    const r = evaluateHazard(load(3), prop(9));
    expect(r.triggered).toBe(true);
    expect("mmi_x10" in r.computed && r.computed.mmi_x10).toBeGreaterThanOrEqual(81);
  });

  it("#6 7007 Peckham Street (Johnston) is within 150 m of an EF2 centerline: YES", () => {
    const r = evaluateHazard(load(4), prop(6));
    expect(r.triggered).toBe(true);
    expect("distance_m" in r.computed && r.computed.distance_m).toBeLessThanOrEqual(150);
  });

  it("missing coverage is refused, never settled NO", () => {
    // Downtown Los Angeles is outside the cropped South Napa grid.
    expect(() => evaluateHazard(load(3), { lat_e6: 34_052_000, lon_e6: -118_244_000, trigger_distance_m: 0 })).toThrow(/not covered/);
  });

  it("rejects a trigger distance that contradicts the method", () => {
    expect(() => evaluateHazard(load(2), { ...prop(8), trigger_distance_m: 500 })).toThrow();
    expect(() => evaluateHazard(load(4), { ...prop(6), trigger_distance_m: 0 })).toThrow();
  });
});

describe("evidence v3", () => {
  it("is canonical, integer-only, deterministic and hashed", () => {
    const s = registry["3"]!;
    const p = prop(9);
    const input = {
      market: MARKET,
      round: KEY,
      programId: KEY,
      property: { id: p.property_id, lat_e6: p.lat_e6, lon_e6: p.lon_e6 },
      scenarioId: 3,
      triggerDistanceM: 0,
      scenario: s,
      dataset: load(3),
    };
    const a = buildEvidenceV3(input);
    const b = buildEvidenceV3(input);
    expect(a.canonical).toBe(b.canonical);
    expect(a.canonical).toBe(canonicalize(JSON.parse(a.canonical)));
    expect(a.hashHex).toBe(sha256Hex(new TextEncoder().encode(a.canonical)));
    expect(a.record).toMatchObject({ version: 3, hazard: "earthquake", triggered: true, scenario_id: 3 });
    expect(a.record.dataset.sha256).toBe(s.sha256);
    expect(a.record.coverage.start).toBe("2014-08-01T07:00:00Z");
  });

  it("refuses a dataset that belongs to another scenario", () => {
    const p = prop(6);
    expect(() =>
      buildEvidenceV3({
        market: MARKET,
        round: KEY,
        programId: KEY,
        property: { id: p.property_id, lat_e6: p.lat_e6, lon_e6: p.lon_e6 },
        scenarioId: 4,
        triggerDistanceM: 500,
        scenario: registry["4"]!,
        dataset: load(2),
      }),
    ).toThrow(/is not scenario/);
  });
});
