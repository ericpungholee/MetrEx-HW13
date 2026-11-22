// Multi-peril catalog (docs/spec-multiperil.md §6): every shipped ladder quotes all twelve levels at
// zero inventory, never crosses, offers no cross-book arbitrage and stays inside 1–9,999 bps.
import { describe, expect, it } from "vitest";
import { CATALOG, catalogByScenario, ladderFor } from "./catalog";
import { DEMO_BOTS, crossBookArbitrage, requoteRound } from "./ladder";
import { MAX_PRICE_BPS, MIN_PRICE_BPS, OrderSide, Outcome } from "./constants";

describe("catalog", () => {
  it("has one market per hazard and scenario, with unique properties", () => {
    expect(new Set(CATALOG.map((c) => c.hazard)).size).toBe(4);
    expect(new Set(CATALOG.map((c) => c.scenarioId)).size).toBe(4);
    expect(new Set(CATALOG.map((c) => c.propertyId)).size).toBe(4);
  });

  it("round labels fit the on-chain 32-byte label", () => {
    for (const c of CATALOG) expect(new TextEncoder().encode(c.roundLabel).length).toBeLessThanOrEqual(32);
  });

  it("names the wildfire replay explicitly and says every hazard pays without regard to damage", () => {
    expect(catalogByScenario(1)?.payoutRule).toBe(
      "Pays the full amount if the final mapped footprint of the January 2025 Palisades Fire came within 500 m of this property. Pays on fire proximity, not on damage.",
    );
    for (const c of CATALOG) expect(c.payoutRule).toMatch(/not on damage\.$/);
  });

  for (const c of CATALOG) {
    it(`${c.hazard}: the ladder posts every level and never crosses`, () => {
      const book = requoteRound(c.ladder, [], new Map(), { skewEnabled: false });
      expect(book.length).toBe(12);
      for (const o of book) {
        expect(o.priceBps).toBeGreaterThanOrEqual(MIN_PRICE_BPS);
        expect(o.priceBps).toBeLessThanOrEqual(MAX_PRICE_BPS);
      }
      const yes = book.filter((o) => o.outcome === Outcome.Yes);
      const bestBid = Math.max(...yes.filter((o) => o.side === OrderSide.Buy).map((o) => o.priceBps));
      const bestAsk = Math.min(...yes.filter((o) => o.side === OrderSide.Sell).map((o) => o.priceBps));
      expect(bestBid).toBeLessThan(bestAsk);
      expect(crossBookArbitrage(book)).toEqual([]);
      // The targets are what was posted: the clamp is only a safety net.
      for (const p of c.ladder) {
        expect(yes.find((o) => o.maker === `bot-${p.name}` && o.side === OrderSide.Buy)?.priceBps).toBe(p.refBps - p.halfSpreadBps);
        expect(yes.find((o) => o.maker === `bot-${p.name}` && o.side === OrderSide.Sell)?.priceBps).toBe(p.refBps + p.halfSpreadBps);
      }
    });
  }

  it("ladderFor falls back from property to scenario to the default bot", () => {
    expect(ladderFor(5, 3, "A", DEMO_BOTS[0]!).refBps).toBe(10);
    expect(ladderFor(2, 1, "B", DEMO_BOTS[1]!).refBps).toBe(90); // property 2 is in the wildfire scenario
    expect(ladderFor(99, 99, "C", DEMO_BOTS[2]!)).toBe(DEMO_BOTS[2]);
  });
});
