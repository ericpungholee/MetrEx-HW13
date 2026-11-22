// Diagnosis of "1 of 10 YES shares can fill" (2026-11-22). The market-order planner accepts a fixed
// 5% from the best executable price (spec-multiperil §7.4). With a 1-share dust ask at 1.19¢ and the
// next maker at 1.74¢, the worst price is 1.19¢ + floor(119 × 5%) = 1.24¢, so only the dust fills.
import { describe, expect, it } from "vitest";
import { OrderSide, Outcome } from "./constants";
import { planMarketOrder, type BookOrder } from "./book";

const ask = (id: string, priceBps: number, remaining: bigint, seq: bigint): BookOrder =>
  ({ id, maker: id, outcome: Outcome.Yes, side: OrderSide.Sell, priceBps, remaining, seq });
const worst = (best: number) => best + Math.floor((best * 500) / 10_000);

describe("dust at the top of the book", () => {
  it("caps a 10-share market buy at the dust quantity", () => {
    const book = [ask("A", 119, 1n, 1n), ask("C", 174, 30_000n, 2n)];
    const r = planMarketOrder(book, { outcome: Outcome.Yes, side: OrderSide.Buy, qty: 10n, worstPriceBps: worst(119), taker: "me" });
    expect(r.fills.map((f) => f.qty)).toEqual([1n]);
    expect(r.unfilled).toBe(9n);
  });

  it("fills completely once the best level has real size", () => {
    const book = [ask("C", 174, 30_000n, 2n)];
    const r = planMarketOrder(book, { outcome: Outcome.Yes, side: OrderSide.Buy, qty: 100n, worstPriceBps: worst(174), taker: "me" });
    expect(r.unfilled).toBe(0n);
  });
});
