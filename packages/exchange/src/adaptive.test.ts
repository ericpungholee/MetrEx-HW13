// Adaptive maker reference (docs/spec-simulation.md §3).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADAPTIVE,
  adaptiveParams,
  diffFills,
  initAdaptive,
  restingMid,
  spreadMultiplier,
  stepAdaptive,
  takerFlowSign,
  yesEquivalentBps,
  type ObservedFill,
} from "./adaptive";
import { CATALOG } from "./catalog";
import { OrderSide, Outcome } from "./constants";
import { clampQuotes, crossBookArbitrage, quotesToOrders, targetQuotes } from "./ladder";
import { crossedPairs } from "./book";
import type { OrderAccount } from "./projection";

const order = (p: Partial<OrderAccount> & Pick<OrderAccount, "address">): OrderAccount => ({
  market: "M", maker: "A", clientNonce: 1n, outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 86,
  originalQty: 60_000n, remainingQty: 60_000n, seq: 1n, expiresAt: 0n, createdAt: 0n, ...p,
});

const lift = (qty: bigint, priceBps = 86): ObservedFill => ({ order: "x", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps, qty });
const hit = (qty: bigint, priceBps = 74): ObservedFill => ({ order: "y", outcome: Outcome.Yes, side: OrderSide.Buy, priceBps, qty });

describe("fill observation", () => {
  it("a remaining decrease is a fill at the order's price; a vanished order is not", () => {
    const prev = [order({ address: "a" }), order({ address: "b", side: OrderSide.Buy, priceBps: 74 })];
    const cur = [order({ address: "a", remainingQty: 45_000n })];
    expect(diffFills(prev, cur)).toEqual([{ order: "a", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 86, qty: 15_000n }]);
    expect(diffFills(cur, cur)).toEqual([]);
  });

  it("flow sign and YES-equivalent price on both books", () => {
    expect(takerFlowSign({ outcome: Outcome.Yes, side: OrderSide.Sell })).toBe(1);
    expect(takerFlowSign({ outcome: Outcome.Yes, side: OrderSide.Buy })).toBe(-1);
    expect(takerFlowSign({ outcome: Outcome.No, side: OrderSide.Sell })).toBe(-1);
    expect(takerFlowSign({ outcome: Outcome.No, side: OrderSide.Buy })).toBe(1);
    expect(yesEquivalentBps({ outcome: Outcome.No, priceBps: 9_914 })).toBe(86);
  });
});

describe("adaptive mid", () => {
  const depth = 60_000n;

  it("buying pressure raises the mid, selling lowers it, each step bounded", () => {
    const s0 = initAdaptive(80, 0);
    const up = stepAdaptive(s0, [lift(60_000n), lift(40_000n, 100)], 2_000, depth);
    expect(up.midBps).toBeGreaterThan(80);
    expect(up.midBps).toBeLessThanOrEqual(80 * (1 + DEFAULT_ADAPTIVE.maxStepFrac) + 1e-9);
    const down = stepAdaptive(s0, [hit(60_000n)], 2_000, depth);
    expect(down.midBps).toBeLessThan(80);
  });

  it("a keeper match (bid and ask both filled) has no net flow", () => {
    const s0 = initAdaptive(80, 0);
    const s = stepAdaptive(s0, [lift(10_000n, 80), hit(10_000n, 80)], 1_000, depth);
    expect(Math.abs(s.midBps - 80)).toBeLessThan(0.05);
  });

  it("sustained flow keeps moving it, inside the anchor band", () => {
    let s = initAdaptive(80, 0);
    for (let i = 1; i <= 200; i++) s = stepAdaptive(s, [lift(60_000n, Math.round(s.midBps * 1.1))], i * 2_000, depth);
    expect(s.midBps).toBeGreaterThan(160);
    expect(s.midBps).toBeLessThanOrEqual(800);
  });

  it("reverts toward the makers' estimate without flow, and the dead band holds small moves", () => {
    let s = { ...initAdaptive(80, 0), midBps: 120, publishedBps: 120 };
    for (let m = 1; m <= 45; m++) s = stepAdaptive(s, [], m * 60_000, depth);
    // One half-life in log-odds from 120 toward 80.
    expect(s.midBps).toBeGreaterThan(95);
    expect(s.midBps).toBeLessThan(101);
    const tiny = stepAdaptive(initAdaptive(80, 0), [lift(100n, 81)], 1_000, depth);
    expect(tiny.publishedBps).toBe(80);
  });

  it("volatility widens the spread up to the cap", () => {
    expect(spreadMultiplier({ vol: 0 })).toBe(1);
    expect(spreadMultiplier({ vol: 100 })).toBe(DEFAULT_ADAPTIVE.maxSpreadMult);
  });

  it("restart recovery reads maker A's resting mid", () => {
    const orders = [order({ address: "a", priceBps: 90 }), order({ address: "b", side: OrderSide.Buy, priceBps: 78 }), order({ address: "c", maker: "B", priceBps: 50 })];
    expect(restingMid(orders, "A")).toBe(84);
    expect(restingMid(orders, "Z")).toBeUndefined();
  });
});

describe("adaptive ladders stay post-only and complement-safe", () => {
  for (const entry of CATALOG) {
    it(`${entry.hazard}: at several mids, sequential clamped quotes never cross or offer complement arbitrage`, () => {
      const refA = entry.ladder[0]!.refBps;
      for (const mult of [0.3, 0.7, 1, 1.6, 4]) {
        const s = { ...initAdaptive(refA, 0), midBps: refA * mult, publishedBps: refA * mult, vol: mult > 1 ? 0.3 : 0 };
        let book: ReturnType<typeof quotesToOrders> = [];
        let seq = 1n;
        for (const base of entry.ladder) {
          const p = adaptiveParams(base, refA, s);
          expect(p.refBps - p.halfSpreadBps).toBeGreaterThanOrEqual(1);
          const q = clampQuotes(p, targetQuotes(p, 0n, true), book, { skewEnabled: true });
          const fresh = quotesToOrders(q, seq);
          seq += BigInt(fresh.length);
          book = [...book, ...fresh];
        }
        expect(crossedPairs(book, Outcome.Yes)).toEqual([]);
        expect(crossedPairs(book, Outcome.No)).toEqual([]);
        expect(crossBookArbitrage(book)).toEqual([]);
        expect(book.length).toBeGreaterThanOrEqual(6);
      }
    });
  }
});
