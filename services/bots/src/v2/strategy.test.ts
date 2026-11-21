// v2 bot strategy (spec-v2 §8, §13.2 Bots): complement quotes, skew bounds, requote thresholds,
// inventory limits, lifecycle, and a three-bot simulation that never crosses either book.
import { describe, expect, it } from "vitest";
import {
  BPS_DENOMINATOR,
  DEMO_BOTS,
  MUSD_UNIT,
  OrderSide,
  Outcome,
  crossBookArbitrage,
  crossedPairs,
  skewedRef,
  type BookOrder,
  type OrderAccount,
} from "@metrex/exchange";
import {
  DEFAULT_BOT_CONFIG,
  applyToSnapshot,
  desiredQuotes,
  inventory,
  inventoryAllows,
  needsRequote,
  ownComplementOk,
  planBotMarket,
  type BotMarketInput,
} from "./strategy";

type Row = BookOrder & { isBot: boolean };
const A = DEMO_BOTS[0]!;
const funded = { musd: 100_000n * MUSD_UNIT, yes: 2_000n, no: 2_000n };

function input(over: Partial<BotMarketInput> = {}): BotMarketInput {
  return {
    params: A,
    config: DEFAULT_BOT_CONFIG,
    maker: "bot-A",
    phase: "trading",
    featured: true,
    balances: funded,
    own: [],
    others: [],
    nowMs: 10_000,
    lastRequoteMs: undefined,
    ...over,
  };
}

function order(p: Partial<OrderAccount> & Pick<OrderAccount, "address">): OrderAccount {
  return {
    market: "M", maker: "bot-A", clientNonce: 1n, outcome: Outcome.Yes, side: OrderSide.Buy, priceBps: 370,
    originalQty: 200n, remainingQty: 200n, seq: 1n, expiresAt: 0n, createdAt: 0n, ...p,
  };
}

describe("quotes", () => {
  it("featured market at zero inventory: A's exact ladder with complement NO", () => {
    const q = desiredQuotes(input());
    expect(q.map((x) => [x.outcome, x.side, x.priceBps, x.size])).toEqual([
      [Outcome.Yes, OrderSide.Buy, 370, 200n],
      [Outcome.Yes, OrderSide.Sell, 430, 200n],
      [Outcome.No, OrderSide.Buy, BPS_DENOMINATOR - 430, 200n],
      [Outcome.No, OrderSide.Sell, BPS_DENOMINATOR - 370, 200n],
    ]);
    expect(ownComplementOk(q)).toBe(true);
  });

  it("skew is bounded by ±skew_max and has the right sign; off on the featured market", () => {
    for (const p of DEMO_BOTS) {
      for (const net of [-1_000_000n, -p.toleranceShares, 0n, p.toleranceShares, 1_000_000n]) {
        const r = skewedRef(p, net, true);
        expect(Math.abs(r - p.refBps)).toBeLessThanOrEqual(p.skewMaxBps);
        if (net < 0n) expect(r).toBeGreaterThanOrEqual(p.refBps); // short YES raises quotes
        if (net > 0n) expect(r).toBeLessThanOrEqual(p.refBps);
        expect(skewedRef(p, net, false)).toBe(p.refBps);
      }
    }
  });

  it("sizes are capped by actual inventory and mUSD, never assumed fills", () => {
    const q = desiredQuotes(input({ balances: { musd: 0n, yes: 50n, no: 0n } }));
    expect(q.map((x) => [x.outcome, x.side, x.size])).toEqual([[Outcome.Yes, OrderSide.Sell, 50n]]);
    // Shares escrowed in own SELL orders count as inventory (they come back on the atomic requote).
    const inv = inventory({ musd: 0n, yes: 0n, no: 0n }, [order({ address: "s", side: OrderSide.Sell, remainingQty: 120n })]);
    expect(inv.yes).toBe(120n);
    expect(inv.netYes).toBe(120n);
  });

  it("inventory limits drop levels instead of moving prices", () => {
    expect(inventoryAllows({ outcome: Outcome.Yes, side: OrderSide.Buy }, 2_000n, 2_000n)).toBe(false);
    expect(inventoryAllows({ outcome: Outcome.No, side: OrderSide.Sell }, 2_000n, 2_000n)).toBe(false);
    expect(inventoryAllows({ outcome: Outcome.Yes, side: OrderSide.Sell }, 2_000n, 2_000n)).toBe(true);
    expect(inventoryAllows({ outcome: Outcome.Yes, side: OrderSide.Sell }, -2_000n, 2_000n)).toBe(false);
    const q = desiredQuotes(input({ balances: { musd: funded.musd, yes: 4_000n, no: 2_000n } }));
    expect(q.map((x) => x.priceBps)).toEqual([430, 9_570]); // long YES: only YES ask and NO bid remain, same prices
  });
});

describe("requote thresholds (§8.1)", () => {
  it("≥ 1 tick or ≥ 10% size", () => {
    expect(needsRequote({ priceBps: 370, remainingQty: 200n }, { priceBps: 370, size: 200n })).toBe(false);
    expect(needsRequote({ priceBps: 371, remainingQty: 200n }, { priceBps: 370, size: 200n })).toBe(true);
    expect(needsRequote({ priceBps: 370, remainingQty: 181n }, { priceBps: 370, size: 200n })).toBe(false);
    expect(needsRequote({ priceBps: 370, remainingQty: 180n }, { priceBps: 370, size: 200n })).toBe(true);
  });

  it("an unchanged resting order is kept; a filled one is replaced atomically; cooldown is respected", () => {
    const own = desiredQuotes(input()).map((q, n) =>
      order({ address: `o${n}`, outcome: q.outcome, side: q.side, priceBps: q.priceBps, remainingQty: q.size, seq: BigInt(n) }),
    );
    expect(planBotMarket(input({ own }))).toEqual([]);
    own[1] = { ...own[1]!, remainingQty: 0n }; // YES ask fully filled
    const acts = planBotMarket(input({ own }));
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ kind: "requote", cancel: { address: "o1" }, place: { priceBps: 430, size: 200n } });
    expect(planBotMarket(input({ own, lastRequoteMs: 9_000 }))).toEqual([]);
  });

  it("splits first when a side can't cover one top size, keeping the mUSD reserve", () => {
    const acts = planBotMarket(input({ balances: { musd: 1_500n * MUSD_UNIT, yes: 0n, no: 0n } }));
    expect(acts[0]).toEqual({ kind: "split", quantity: 500n });
  });

  it("quotes in the same plan as the split, on the post-split balances", () => {
    const acts = planBotMarket(input({ balances: { musd: 3_000n * MUSD_UNIT, yes: 0n, no: 0n } }));
    expect(acts[0]).toEqual({ kind: "split", quantity: 2_000n });
    const placed = acts.flatMap((a) => (a.kind === "requote" && a.place ? [a.place] : []));
    // Same quotes as a bot already holding the split shares and the remaining mUSD.
    const held = planBotMarket(input({ balances: { musd: 1_000n * MUSD_UNIT, yes: 2_000n, no: 2_000n } }));
    expect(placed).toEqual(held.flatMap((a) => (a.kind === "requote" && a.place ? [a.place] : [])));
    expect(placed.length).toBe(4);
    // Asks never exceed the shares the split creates.
    for (const q of placed) if (q.side === OrderSide.Sell) expect(q.size <= 2_000n).toBe(true);
    // Inside the cooldown: split only.
    expect(planBotMarket(input({ balances: { musd: 3_000n * MUSD_UNIT, yes: 0n, no: 0n }, lastRequoteMs: 9_000 }))).toEqual([{ kind: "split", quantity: 2_000n }]);
  });
});

describe("lifecycle (§8.1)", () => {
  const o = order({ address: "x", side: OrderSide.Sell });
  it("after close: cancel own orders, then merge leftover pairs", () => {
    expect(planBotMarket(input({ phase: "closed", own: [o] }))).toEqual([{ kind: "cancel", orders: [o], reason: "closed" }]);
    expect(planBotMarket(input({ phase: "closed", balances: { musd: 0n, yes: 300n, no: 120n } }))).toEqual([{ kind: "merge", quantity: 120n }]);
  });
  it("after resolution: redeem winners only (both sides on Invalid)", () => {
    const b = { musd: 0n, yes: 300n, no: 120n };
    expect(planBotMarket(input({ phase: "resolved_yes", balances: b }))).toEqual([{ kind: "redeem", outcome: Outcome.Yes, quantity: 300n }]);
    expect(planBotMarket(input({ phase: "resolved_no", balances: b }))).toEqual([{ kind: "redeem", outcome: Outcome.No, quantity: 120n }]);
    expect(planBotMarket(input({ phase: "resolved_invalid", balances: b }))).toEqual([
      { kind: "redeem", outcome: Outcome.Yes, quantity: 300n },
      { kind: "redeem", outcome: Outcome.No, quantity: 120n },
    ]);
  });
});

describe("three bots, sequential ticks against a shared snapshot", () => {
  function tick(book: Row[], featured: boolean, balances: Map<string, typeof funded>): Row[] {
    let snap = book;
    let seq = snap.reduce((m, r) => (r.seq > m ? r.seq : m), 0n) + 1n;
    for (const p of DEMO_BOTS) {
      const maker = `bot-${p.name}`;
      const own: OrderAccount[] = snap
        .filter((r) => r.maker === maker)
        .map((r) => order({ address: r.id, maker, outcome: r.outcome, side: r.side, priceBps: r.priceBps, remainingQty: r.remaining, seq: r.seq }));
      const acts = planBotMarket(input({ params: p, maker, featured, own, others: snap.filter((r) => r.maker !== maker), balances: balances.get(p.name) ?? funded }));
      const cancelled: string[] = [];
      const placed: { id: string; quote: NonNullable<Extract<(typeof acts)[number], { kind: "requote" }>["place"]> }[] = [];
      for (const a of acts) {
        if (a.kind !== "requote") continue;
        if (a.cancel) cancelled.push(a.cancel.address);
        if (a.place) placed.push({ id: `${maker}-${seq + BigInt(placed.length)}`, quote: a.place });
      }
      snap = applyToSnapshot(snap, maker, cancelled, placed, seq);
      seq += BigInt(placed.length);
    }
    return snap;
  }

  it("quotes both books without crossing or cross-book arbitrage, and settles (no churn)", () => {
    for (const featured of [true, false]) {
      let b = tick([], featured, new Map());
      b = tick(b, featured, new Map());
      expect(b.filter((r) => r.isBot)).toHaveLength(12);
      expect(crossedPairs(b, Outcome.Yes)).toEqual([]);
      expect(crossedPairs(b, Outcome.No)).toEqual([]);
      expect(crossBookArbitrage(b)).toEqual([]);
      const again = tick(b, featured, new Map());
      expect(again.map((r) => r.id).sort()).toEqual(b.map((r) => r.id).sort()); // stable: nothing requoted
    }
  });

  it("a respected resting user ask stays uncrossed after every bot requotes (§8.3)", () => {
    const user: Row = { id: "presenter", maker: "presenter", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 410, remaining: 100n, seq: 0n, isBot: false };
    let b = tick([user], true, new Map());
    for (let n = 0; n < 3; n++) b = tick(b, true, new Map());
    expect(crossedPairs(b, Outcome.Yes)).toEqual([]);
    expect(Math.max(...b.filter((r) => r.isBot && r.outcome === Outcome.Yes && r.side === OrderSide.Buy).map((r) => r.priceBps))).toBe(409);
  });
});
