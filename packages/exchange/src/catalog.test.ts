// Multi-peril catalog (docs/spec-multiperil.md §6): every shipped ladder quotes all twelve levels at
// zero inventory, never crosses, offers no cross-book arbitrage and stays inside 1–9,999 bps.
import { describe, expect, it } from "vitest";
import { CATALOG, LISTINGS, anchorLadder, catalogByProperty, catalogByScenario, entryFor, homeMarket, ladderFor, listingsOf, makerCapitalFor, openingBidBps } from "./catalog";
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

  it("listings are distinct real addresses on the featured hazards, with smaller ladders", () => {
    const ids = [...CATALOG, ...LISTINGS].map((c) => c.propertyId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const h of ["wildfire", "hurricane", "earthquake", "tornado"] as const) expect(listingsOf(h).length).toBeGreaterThan(0);
    for (const l of LISTINGS) {
      const f = catalogByScenario(l.scenarioId)!;
      expect(l.hazard).toBe(f.hazard);
      expect(l.payoutRule).toBe(f.payoutRule);
      expect(l.question).toContain(l.address);
      expect(new TextEncoder().encode(l.address).length).toBeLessThanOrEqual(32);
      expect(catalogByProperty(l.propertyId)).toBe(l);
      expect(l.ladder.map((b) => b.refBps)).toEqual(f.ladder.map((b) => b.refBps));
      expect(l.ladder[0]!.topSize).toBeLessThan(f.ladder[0]!.topSize);
    }
  });

  it("maker capital caps never exceed the total", () => {
    const total = 1_500_000_000_000n;
    const sum = [...CATALOG, ...LISTINGS].reduce((a, c) => a + makerCapitalFor(c.propertyId, total)!, 0n);
    expect(sum).toBeLessThanOrEqual(total);
    expect(makerCapitalFor(1, total)).toBeUndefined();
  });

  it("homeowner markets take the hazard's rules and their own address", () => {
    const h = homeMarket(1200, 2, "123 Example Street", "Coral Gables, Florida")!;
    expect(h.hazard).toBe("hurricane");
    expect(h.payoutRule).toBe(catalogByScenario(2)!.payoutRule);
    expect(h.question).toContain("123 Example Street");
    expect(homeMarket(12, 2, "x")).toBeUndefined();
    expect(entryFor(7, 1)).toBe(catalogByProperty(7));
    expect(entryFor(1200, 4, "1 Main Street")?.hazard).toBe("tornado");
    expect(entryFor(1200, 4)).toBeUndefined();
  });

  it("the opening bid is the oldest non-maker YES bid", () => {
    const o = (maker: string, outcome: 0 | 1, side: 0 | 1, priceBps: number, seq: bigint) => ({ maker, outcome, side, priceBps, seq });
    const book = [o("bot", 0, 0, 90, 1n), o("home", 0, 0, 120, 3n), o("sim", 0, 0, 130, 5n), o("home", 1, 0, 9000, 0n)];
    expect(openingBidBps(book, (m) => m === "bot")).toBe(120);
    expect(openingBidBps([o("bot", 0, 0, 90, 1n)], (m) => m === "bot")).toBeUndefined();
  });

  it("anchorLadder re-centres maker A on the opening bid and stays inside 1–9,999", () => {
    const base = catalogByScenario(1)!.ladder;
    const l = anchorLadder(base, 160);
    expect(l[0]!.refBps).toBe(160);
    expect(l[0]!.halfSpreadBps).toBe(12);
    for (const x of [anchorLadder(base, 1), anchorLadder(base, 9_999), anchorLadder(catalogByScenario(3)!.ladder, 2)]) {
      for (const b of x) {
        expect(b.refBps - b.halfSpreadBps).toBeGreaterThanOrEqual(1);
        expect(b.refBps + b.halfSpreadBps).toBeLessThanOrEqual(9_999);
        expect(b.halfSpreadBps).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
