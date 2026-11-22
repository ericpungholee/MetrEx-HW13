import { describe, expect, it } from "vitest";
import { roundMemberError } from "./operator";

// Market-page settlement settles the market's whole round (docs/spec-simulation.md §7.1).
describe("roundMemberError", () => {
  const round = "Round1111111111111111111111111111111111111";
  it("accepts the only market of the round", () => {
    expect(roundMemberError("M1", round, [{ address: "M1", round }])).toBeNull();
  });
  it("accepts a market whose round has sibling markets", () => {
    expect(roundMemberError("M1", round, [{ address: "M1", round }, { address: "M2", round }])).toBeNull();
  });
  it("refuses a market of another round", () => {
    expect(roundMemberError("M9", round, [{ address: "M1", round }])).toMatch(/does not belong/);
    expect(roundMemberError("M1", round, [{ address: "M1", round: "Other" }])).toMatch(/does not belong/);
  });
});
