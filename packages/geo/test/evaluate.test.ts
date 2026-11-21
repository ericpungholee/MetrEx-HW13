// §8.2 trigger evaluation on synthetic geometry.
import type { MultiPolygon, Polygon, Position } from "geojson";
import { describe, expect, it } from "vitest";
import { evaluate } from "../src";

// Local metre offsets around a reference point (equirectangular approximation).
const LAT0 = 34.05;
const LON0 = -118.52;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

function pos(dxM: number, dyM: number): Position {
  return [LON0 + dxM / M_PER_DEG_LON, LAT0 + dyM / M_PER_DEG_LAT];
}
/** Closed square ring centred at (cx, cy) metres with half-size h metres. */
function square(cx: number, cy: number, h: number): Position[] {
  return [pos(cx - h, cy - h), pos(cx + h, cy - h), pos(cx + h, cy + h), pos(cx - h, cy + h), pos(cx - h, cy - h)];
}
function at(dxM: number, dyM: number, trigger = 500) {
  const p = pos(dxM, dyM);
  return { lon_e6: Math.round(p[0]! * 1e6), lat_e6: Math.round(p[1]! * 1e6), trigger_distance_m: trigger };
}

const SOLID: Polygon = { type: "Polygon", coordinates: [square(0, 0, 5_000)] };
// Outer 10 km half-size with a 2 km half-size unburned island (hole) in the middle.
const WITH_HOLE: Polygon = { type: "Polygon", coordinates: [square(0, 0, 10_000), square(0, 0, 2_000)] };
const MULTI: MultiPolygon = {
  type: "MultiPolygon",
  coordinates: [[square(0, 0, 1_000)], [square(20_000, 0, 1_000), square(20_000, 0, 300)]],
};

describe("evaluate §8.2", () => {
  it("point deep inside → triggered", () => {
    const r = evaluate(SOLID, at(0, 0));
    expect(r.inside).toBe(true);
    expect(r.triggered).toBe(true);
    expect(r.distance_m).toBeGreaterThan(4_900);
    expect(r.distance_m).toBeLessThan(5_100);
    expect(Number.isInteger(r.distance_m)).toBe(true);
  });

  it("point 400 m outside → triggered", () => {
    const r = evaluate(SOLID, at(5_400, 0));
    expect(r.inside).toBe(false);
    expect(r.distance_m).toBeGreaterThan(350);
    expect(r.distance_m).toBeLessThan(450);
    expect(r.triggered).toBe(true);
  });

  it("point 600 m outside → not triggered", () => {
    const r = evaluate(SOLID, at(5_600, 0));
    expect(r.inside).toBe(false);
    expect(r.distance_m).toBeGreaterThan(550);
    expect(r.distance_m).toBeLessThan(650);
    expect(r.triggered).toBe(false);
  });

  it("point inside a hole, > 500 m from every ring → not triggered", () => {
    const r = evaluate(WITH_HOLE, at(0, 0));
    expect(r.inside).toBe(false);
    expect(r.distance_m).toBeGreaterThan(1_900);
    expect(r.distance_m).toBeLessThan(2_100);
    expect(r.triggered).toBe(false);
  });

  it("point inside a hole, < 500 m from the hole edge → triggered", () => {
    const r = evaluate(WITH_HOLE, at(1_700, 0));
    expect(r.inside).toBe(false);
    expect(r.distance_m).toBeGreaterThan(250);
    expect(r.distance_m).toBeLessThan(350);
    expect(r.triggered).toBe(true);
  });

  it("point in the burned ring around a hole is inside", () => {
    const r = evaluate(WITH_HOLE, at(6_000, 0));
    expect(r.inside).toBe(true);
    expect(r.triggered).toBe(true);
  });

  it("multipolygon: inside any polygon counts, distance is min over every ring", () => {
    expect(evaluate(MULTI, at(20_700, 0)).inside).toBe(true); // second polygon, outside its hole
    const inHole = evaluate(MULTI, at(20_000, 0)); // inside second polygon's hole
    expect(inHole.inside).toBe(false);
    expect(inHole.distance_m).toBeGreaterThan(250); // nearest ring is the hole edge (~300 m)
    expect(inHole.distance_m).toBeLessThan(350);
    expect(inHole.triggered).toBe(true);
    const between = evaluate(MULTI, at(10_000, 0)); // ~9 km from both
    expect(between.inside).toBe(false);
    expect(between.distance_m).toBeGreaterThan(8_800);
    expect(between.distance_m).toBeLessThan(9_200);
    expect(between.triggered).toBe(false);
    const near2 = evaluate(MULTI, at(18_600, 0)); // 400 m west of polygon 2
    expect(near2.triggered).toBe(true);
  });

  it("does not trigger when a fractional distance above the threshold rounds down to it", () => {
    const base = at(5_501, 0);
    expect(evaluate(SOLID, base)).toEqual({ inside: false, distance_m: 500, triggered: false });
    expect(evaluate(SOLID, { ...base, trigger_distance_m: 501 }).triggered).toBe(true);
  });

  it("rejects non-integer or out-of-range inputs", () => {
    expect(() => evaluate(SOLID, { lat_e6: 34.5, lon_e6: 0, trigger_distance_m: 500 })).toThrow();
    expect(() => evaluate(SOLID, { lat_e6: 91_000_000, lon_e6: 0, trigger_distance_m: 500 })).toThrow();
    expect(() => evaluate(SOLID, { lat_e6: 0, lon_e6: 0, trigger_distance_m: -1 })).toThrow();
    expect(() => evaluate(SOLID, { lat_e6: 0, lon_e6: 0, trigger_distance_m: Number.NaN })).toThrow();
  });

  it("is deterministic", () => {
    expect(evaluate(WITH_HOLE, at(1_700, 0))).toEqual(evaluate(WITH_HOLE, at(1_700, 0)));
  });
});
