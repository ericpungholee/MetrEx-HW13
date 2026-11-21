import { pointToLineDistance } from "@turf/point-to-line-distance";
import { expect, it, vi } from "vitest";
import { evaluate } from "../src/evaluate";

vi.mock("@turf/point-to-line-distance", () => ({ pointToLineDistance: vi.fn() }));

it("includes exactly 500 m and excludes distances just beyond it", () => {
  const square = {
    type: "Polygon" as const,
    coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
  };
  const property = { lat_e6: 0, lon_e6: 1_004_497, trigger_distance_m: 500 };
  for (const [distance, triggered] of [[499.999, true], [500, true], [500.001, false]] as const) {
    vi.mocked(pointToLineDistance).mockReturnValue(distance);
    expect(evaluate(square, property)).toEqual({ inside: false, distance_m: Math.floor(distance), triggered });
  }
});
