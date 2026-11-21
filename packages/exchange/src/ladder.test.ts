// Adversarial market-maker tests (spec-v2 §13.2, freeze-review check 4) and the one-wallet
// partial-fill replay (§8.3, §11, check 5). Pure: no chain access.
import { describe, expect, it } from "vitest";
import {
  BPS_DENOMINATOR,
  DEMO_BOTS,
  Outcome,
  OrderSide,
  applyFills,
  bestAsk,
  bestBid,
  crossBookArbitrage,
  crossedPairs,
  planLimitOrder,
  planMarketOrder,
  requoteRound,
  type BookOrder,
  type OutcomeCode,
} from "./index";

type Row = BookOrder & { isBot: boolean };
const ZERO = new Map<string, bigint>();
const featured = { skewEnabled: false };

function ladder(netYes = ZERO, opts = featured, book: Row[] = []): Row[] {
  return requoteRound(DEMO_BOTS, requoteRound(DEMO_BOTS, book, netYes, opts), netYes, opts);
}

const botPrices = (b: Row[], outcome: OutcomeCode, side: 0 | 1) =>
  b.filter((o) => o.isBot && o.outcome === outcome && o.side === side).map((o) => o.priceBps);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("bot ladder — adversarial (§13.2)", () => {
  it("shipped ladder is exactly the spec's", () => {
    const b = ladder();
    expect(botPrices(b, Outcome.Yes, OrderSide.Buy).sort((x, y) => y - x)).toEqual([410, 400, 370]);
    expect(botPrices(b, Outcome.Yes, OrderSide.Sell).sort((x, y) => x - y)).toEqual([430, 500, 590]);
    expect(botPrices(b, Outcome.No, OrderSide.Buy).sort((x, y) => y - x)).toEqual([9570, 9500, 9410]);
    expect(botPrices(b, Outcome.No, OrderSide.Sell).sort((x, y) => x - y)).toEqual([9590, 9600, 9630]);
  });

  for (const outcome of [Outcome.Yes, Outcome.No] as const) {
    it(`bots-no-cross-${outcome === Outcome.Yes ? "yes" : "no"}: highest bot bid < lowest bot ask`, () => {
      for (const skewEnabled of [false, true]) {
        const b = ladder(ZERO, { skewEnabled });
        expect(Math.max(...botPrices(b, outcome, OrderSide.Buy))).toBeLessThan(
          Math.min(...botPrices(b, outcome, OrderSide.Sell)),
        );
      }
    });
  }

  it("bots-no-cross-book-arb: every ordered bot pair, both directions", () => {
    const b = ladder();
    expect(crossBookArbitrage(b)).toEqual([]);
    // Explicitly, including i = j: yes_bid_i + no_bid_j ≤ 10,000 and yes_ask_i + no_ask_j ≥ 10,000.
    const bots = DEMO_BOTS.map((p) => `bot-${p.name}`);
    for (const i of bots) {
      for (const j of bots) {
        const px = (m: string, o: OutcomeCode, s: 0 | 1) => b.find((x) => x.maker === m && x.outcome === o && x.side === s)!.priceBps;
        expect(px(i, Outcome.Yes, OrderSide.Buy) + px(j, Outcome.No, OrderSide.Buy)).toBeLessThanOrEqual(BPS_DENOMINATOR);
        expect(px(i, Outcome.Yes, OrderSide.Sell) + px(j, Outcome.No, OrderSide.Sell)).toBeGreaterThanOrEqual(BPS_DENOMINATOR);
      }
    }
  });

  it("bots-keeper-idle: an all-bot book gives the keeper nothing to match", () => {
    const b = ladder();
    expect(crossedPairs(b, Outcome.Yes)).toEqual([]);
    expect(crossedPairs(b, Outcome.No)).toEqual([]);
  });

  it("bots-randomized: 5,000 seeded books with skewed inventories and user orders on both books", () => {
    const r = rng(20261121);
    for (let k = 0; k < 5_000; k++) {
      const netYes = new Map<string, bigint>(
        DEMO_BOTS.map((p) => [p.name, BigInt(Math.round((r() * 2 - 1) * Number(p.toleranceShares) * 1.5))]),
      );
      const users: Row[] = [];
      const n = Math.floor(r() * 7);
      for (let u = 0; u < n; u++) {
        users.push({
          id: `u${u}`,
          maker: `user-${u % 3}`,
          outcome: (r() < 0.5 ? 0 : 1) as OutcomeCode,
          side: (r() < 0.5 ? 0 : 1) as 0 | 1,
          priceBps: 1 + Math.floor(r() * 9_999),
          remaining: BigInt(1 + Math.floor(r() * 500)),
          seq: BigInt(u + 1),
          isBot: false,
        });
      }
      const b = requoteRound(DEMO_BOTS, requoteRound(DEMO_BOTS, users, netYes, { skewEnabled: true }), netYes, {
        skewEnabled: true,
      });
      // No bot-vs-bot crosses on either book, and no cross-book arbitrage across bot quotes.
      for (const outcome of [Outcome.Yes, Outcome.No] as const) {
        for (const [bid, ask] of crossedPairs(b, outcome)) {
          const pair = [bid, ask] as Row[];
          expect(pair.every((o) => o.isBot), `case ${k}: bots crossed each other`).toBe(false);
          // A bot may only cross a user order the respect rule ignores (dust or far out of band).
          const user = pair.find((o) => !o.isBot);
          const botO = pair.find((o) => o.isBot);
          if (user && botO) {
            const p = DEMO_BOTS.find((x) => `bot-${x.name}` === botO.maker)!;
            const yesEquiv = user.outcome === Outcome.Yes ? user.priceBps : BPS_DENOMINATOR - user.priceBps;
            const respected = user.remaining >= 10n && Math.abs(yesEquiv - p.refBps) <= 300;
            expect(respected, `case ${k}: bot crossed a respected user order`).toBe(false);
          }
        }
      }
      expect(crossBookArbitrage(b), `case ${k}`).toEqual([]);
    }
  });

  it("bots-respect-resting-user: a user ask inside the spread is never crossed, on either book", () => {
    const users: Row[] = [
      { id: "u-yes", maker: "presenter", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 410, remaining: 100n, seq: 1n, isBot: false },
      { id: "u-no", maker: "presenter", outcome: Outcome.No, side: OrderSide.Sell, priceBps: 9_560, remaining: 100n, seq: 2n, isBot: false },
    ];
    const b = ladder(ZERO, featured, users);
    expect(Math.max(...botPrices(b, Outcome.Yes, OrderSide.Buy))).toBeLessThan(410);
    expect(Math.max(...botPrices(b, Outcome.No, OrderSide.Buy))).toBeLessThan(9_560);
    expect(crossedPairs(b, Outcome.Yes)).toEqual([]);
    expect(crossedPairs(b, Outcome.No)).toEqual([]);
  });

  it("a dust order at an absurd price cannot erase bot depth (griefing)", () => {
    const dust: Row[] = [
      { id: "g1", maker: "griefer", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 1, remaining: 1n, seq: 1n, isBot: false },
      { id: "g2", maker: "griefer", outcome: Outcome.No, side: OrderSide.Buy, priceBps: 9_999, remaining: 1n, seq: 2n, isBot: false },
    ];
    const b = ladder(ZERO, featured, dust);
    expect(botPrices(b, Outcome.Yes, OrderSide.Buy).sort((x, y) => y - x)).toEqual([410, 400, 370]);
  });
});

describe("demo-partial-fill (§8.3, §11): one Phantom wallet against funded bots", () => {
  it("buy 300 at market, then sell 200 limit at the best bid: exactly 100 fills and 100 rests", () => {
    let book = ladder();
    expect(bestBid(book, Outcome.Yes)).toMatchObject({ maker: "bot-C", priceBps: 410, remaining: 100n });

    // 0:35 — market buy 300 YES with a 200 bps slippage cap over the best ask (430 → 630).
    const buy = planMarketOrder(book, { outcome: Outcome.Yes, side: OrderSide.Buy, qty: 300n, worstPriceBps: 630, taker: "presenter" });
    expect(buy.fills.map((f) => [f.maker, f.qty, f.priceBps])).toEqual([
      ["bot-A", 200n, 430],
      ["bot-B", 100n, 500],
    ]);
    expect(buy.unfilled).toBe(0n);
    expect(buy.totalQuote).toBe(13_600_000n); // 8.6 + 5.0 mUSD
    book = applyFills(book, buy.fills) as Row[];

    // Bots requote after the fills (A, B now short YES). Featured market: skew off.
    const inv = new Map<string, bigint>([["A", -200n], ["B", -100n]]);
    book = requoteRound(DEMO_BOTS, book as Row[], inv, featured);
    expect(bestBid(book, Outcome.Yes)).toMatchObject({ maker: "bot-C", priceBps: 410, remaining: 100n });

    // 1:15 — limit sell 200 @ 410 (the best bid).
    const sell = planLimitOrder(book, { outcome: Outcome.Yes, side: OrderSide.Sell, qty: 200n, priceBps: 410, maker: "presenter" });
    expect(sell.fills.map((f) => [f.maker, f.qty, f.priceBps])).toEqual([["bot-C", 100n, 410]]);
    expect(sell.rests).toBe(100n);
    expect(sell.totalQuote).toBe(4_100_000n);
    const maxSeq = book.reduce((m, o) => (o.seq > m ? o.seq : m), 0n);
    book = [
      ...(applyFills(book, sell.fills) as Row[]),
      { id: "presenter-ask", maker: "presenter", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 410, remaining: 100n, seq: maxSeq + 1n, isBot: false },
    ];

    // Every bot requotes again (C now long 100 YES): the presenter's remainder must still rest.
    const inv2 = new Map<string, bigint>([["A", -200n], ["B", -100n], ["C", 100n]]);
    for (let i = 0; i < 3; i++) book = requoteRound(DEMO_BOTS, book as Row[], inv2, featured);
    expect(crossedPairs(book, Outcome.Yes)).toEqual([]);
    expect(book.find((o) => o.id === "presenter-ask")?.remaining).toBe(100n);
    expect(bestAsk(book, Outcome.Yes)).toMatchObject({ maker: "presenter", priceBps: 410 });
    expect(bestBid(book, Outcome.Yes)!.priceBps).toBeLessThanOrEqual(409);
  });

  it("why skew is off on the featured market: with skew on, large inventories move the top bid", () => {
    const inv = new Map<string, bigint>([["A", -2_000n], ["B", -4_000n]]);
    const withSkew = ladder(inv, { skewEnabled: true });
    const top = bestBid(withSkew, Outcome.Yes)!;
    expect(top.maker).not.toBe("bot-C"); // the partial-fill size would no longer be 100
    const noSkew = ladder(inv, featured);
    expect(bestBid(noSkew, Outcome.Yes)).toMatchObject({ maker: "bot-C", priceBps: 410 });
  });
});
