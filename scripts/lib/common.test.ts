import { describe, expect, it } from "vitest";
import type { ScenarioRegistry } from "@metrex/shared";
import { validateProperties } from "./common";

const registry = { "1": { scenarioId: 1 } } as unknown as ScenarioRegistry;
const good = {
  property_id: 1,
  label: "Palisades · Home #1042",
  lat_e6: 34_045_000,
  lon_e6: -118_526_000,
  scenario_id: 1,
  trigger_distance_m: 500,
  expected: "YES",
  distance_m: 0,
  inside: true,
};

describe("validateProperties", () => {
  it("accepts well-formed rows", () => {
    const { rows, errors } = validateProperties([good, { ...good, property_id: 2 }], registry);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.property_id)).toEqual([1, 2]);
  });

  it("rejects non-arrays, bad ranges, long labels, duplicates and unknown scenarios", () => {
    expect(validateProperties({}, registry).errors).toEqual(["properties.json must be an array"]);
    const { rows, errors } = validateProperties(
      [
        good,
        { ...good },
        { ...good, property_id: 3, lat_e6: 91_000_000 },
        { ...good, property_id: 4, lon_e6: 1.5 },
        { ...good, property_id: 5, label: "x".repeat(33) },
        { ...good, property_id: 6, scenario_id: 9 },
        { ...good, property_id: 7, trigger_distance_m: 400 },
        { ...good, property_id: 70_000 },
      ],
      registry,
    );
    expect(rows.map((r) => r.property_id)).toEqual([1]);
    expect(errors).toHaveLength(7);
    expect(errors.join("\n")).toMatch(/duplicate property_id 1/);
    expect(errors.join("\n")).toMatch(/max 32/);
    expect(errors.join("\n")).toMatch(/scenario_id 9 not in/);
  });
});
