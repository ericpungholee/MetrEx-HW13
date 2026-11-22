// Remaining-time label counts down to the on-chain trading_ends_at (docs/spec-simulation.md §6).
import { describe, expect, it } from "vitest";
import { CATALOG } from "@metrex/exchange";
import { currentRounds, formatRemaining } from "./exchange-format";

describe("formatRemaining", () => {
  const now = 1_800_000_000_000;
  const at = (s: number) => BigInt(now / 1000 + s);
  it("shows days and hours for a 7-day window", () => expect(formatRemaining(at(168 * 3600), now)).toBe("7d 0h"));
  it("shows hours and minutes, then minutes and seconds", () => {
    expect(formatRemaining(at(4 * 3600 + 12 * 60 + 5), now)).toBe("4h 12m");
    expect(formatRemaining(at(200), now)).toBe("3m 20s");
  });
  it("returns null once the deadline has passed", () => {
    expect(formatRemaining(at(0), now)).toBeNull();
    expect(formatRemaining(at(-60), now)).toBeNull();
  });
});

// Reset market replaces a round; the portfolio keeps only the current round of each catalog market.
describe("currentRounds", () => {
  const [a, b] = CATALOG;
  const round = (roundId: number, entry: typeof a) => ({ roundId: BigInt(roundId), scenarioId: entry!.scenarioId, markets: [{ propertyId: entry!.propertyId }] });
  it("keeps the newest round per catalog market and drops reset ones", () => {
    const old = round(10, a), fresh = round(12, a), other = round(11, b);
    expect(currentRounds([old, other, fresh])).toEqual([other, fresh]);
  });
  it("drops rounds that are not catalog markets", () => {
    expect(currentRounds([{ roundId: 1n, scenarioId: 999, markets: [{ propertyId: 1 }] }])).toEqual([]);
  });
});
