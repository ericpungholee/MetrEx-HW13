// Scenario registry loading (§8.1) and the real packaged perimeter (§8.2, §8.3).
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScenarioRegistry } from "@metrex/shared";
import { describe, expect, it } from "vitest";
import { buildEvidence, evaluate } from "../src";
import { loadScenarioGeometry, loadScenarioRegistry } from "../src/node";

const DATA_DIR = join(__dirname, "..", "..", "..", "data");

describe("loadScenarioGeometry", () => {
  const registry = loadScenarioRegistry(DATA_DIR);

  it("loads scenario 1 and verifies its SHA-256", () => {
    const { scenario, geometry } = loadScenarioGeometry(registry, 1, DATA_DIR);
    expect(scenario.name).toBe("palisades-2025");
    expect(geometry.type).toBe("MultiPolygon");
    expect(geometry.coordinates.length).toBe(16);
  });

  it("refuses an unknown scenario id", () => {
    expect(() => loadScenarioGeometry(registry, 99, DATA_DIR)).toThrow(/Unknown scenario_id 99/);
    // Multi-peril scenarios exist but are not fire perimeters: the wildfire loader still refuses them.
    expect(() => loadScenarioGeometry(registry, 2, DATA_DIR)).toThrow(/not a single-MultiPolygon/);
    expect(() => loadScenarioGeometry(registry, 0, DATA_DIR)).toThrow(/Unknown scenario_id/);
  });

  it("refuses a dataset whose hash does not match the registry", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrex-geo-"));
    const entry = registry["1"]!;
    const original = readFileSync(join(DATA_DIR, entry.file), "utf8");
    writeFileSync(join(dir, entry.file), original.replace("-118.5", "-118.6"));
    expect(() => loadScenarioGeometry(registry, 1, dir)).toThrow(/hash mismatch/);

    copyFileSync(join(DATA_DIR, entry.file), join(dir, entry.file));
    const tampered: ScenarioRegistry = { "1": { ...entry, sha256: "0".repeat(64) } };
    expect(() => loadScenarioGeometry(tampered, 1, dir)).toThrow(/hash mismatch/);
  });

  it("refuses a file path that escapes data/", () => {
    const entry = registry["1"]!;
    const bad: ScenarioRegistry = { "1": { ...entry, file: "../package.json" } };
    expect(() => loadScenarioGeometry(bad, 1, DATA_DIR)).toThrow(/bare file name/);
  });
});

interface PropertyRecord {
  property_id: number;
  label: string;
  lat_e6: number;
  lon_e6: number;
  scenario_id: number;
  trigger_distance_m: number;
}

describe("real perimeter: registered demo properties (§8.3)", () => {
  const propsPath = join(DATA_DIR, "properties.json");
  const properties: PropertyRecord[] = existsSync(propsPath)
    ? (JSON.parse(readFileSync(propsPath, "utf8")) as PropertyRecord[])
    : [];

  it("has the three demo properties", () => {
    expect(properties.map((p) => p.property_id)).toEqual([1, 2, 3]);
  });

  const { geometry, scenario } = loadScenarioGeometry(loadScenarioRegistry(DATA_DIR), 1, DATA_DIR);

  it("evidence on the real file is byte-identical across runs", () => {
    const p = properties[0]!;
    const make = () =>
      buildEvidence({
        market: "11111111111111111111111111111111",
        programId: "BPFLoaderUpgradeab1e11111111111111111111111",
        property: { id: p.property_id, lat_e6: p.lat_e6, lon_e6: p.lon_e6 },
        scenarioId: p.scenario_id,
        triggerDistanceM: p.trigger_distance_m,
        scenario,
        geometry,
      });
    const a = make();
    const b = make();
    expect(a.canonical).toBe(b.canonical);
    expect(a.hashHex).toBe(b.hashHex);
    expect(a.record.dataset.sha256).toBe("8447bc02b2789c45d278327b4997789fb42112e457715b30847b2cbd64073b4a");
  });

  const expectedById = new Map([[1, [true, 672]], [2, [false, 4000]], [3, [true, 559]]] as const);
  for (const p of properties) {
    const [triggered, distance] = expectedById.get(p.property_id as 1 | 2 | 3)!;
    it(`property ${p.property_id} (${p.label}) → ${triggered ? "YES" : "NO"}`, () => {
      const r = evaluate(geometry, p);
      expect(r.triggered).toBe(triggered);
      expect(r.inside).toBe(triggered);
      expect(r.distance_m).toBe(distance);
      if (triggered) {
        expect(r.inside).toBe(true);
        expect(r.distance_m).toBeGreaterThanOrEqual(300);
      } else {
        expect(r.inside).toBe(false);
        expect(r.distance_m).toBeGreaterThanOrEqual(2_000);
      }
    });
  }
});
