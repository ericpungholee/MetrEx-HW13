import { describe, expect, it } from "vitest";
import { soleMarketError } from "./operator";

// Market-page settlement must never close sibling markets (docs/spec-simulation.md §7.1).
describe("soleMarketError", () => {
  const round = "Round1111111111111111111111111111111111111";
  it("accepts the only market of the round", () => {
    expect(soleMarketError("M1", round, [{ address: "M1", round }])).toBeNull();
  });
  it("refuses a round with sibling markets", () => {
    expect(soleMarketError("M1", round, [{ address: "M1", round }, { address: "M2", round }])).toMatch(/2 markets/);
  });
  it("refuses a market of another round", () => {
    expect(soleMarketError("M9", round, [{ address: "M1", round }])).toMatch(/does not belong/);
    expect(soleMarketError("M1", round, [{ address: "M1", round: "Other" }])).toMatch(/does not belong/);
  });
});
