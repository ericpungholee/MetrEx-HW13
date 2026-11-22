// V7 simulation (docs/spec-simulation.md): population, bulletins and decision invariants.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { BPS_DENOMINATOR, CATALOG, MAX_ORDER_QTY, MUSD_UNIT, OrderSide, Outcome, QUOTE_PER_SHARE_BPS, clampQuotes, quotesToOrders, targetQuotes, type BookOrder } from "@metrex/exchange";
import { assertNoOracleData } from "./guard";
import { bulletinsBetween, signalAt, DEFAULT_INFO } from "./info";
import { MidHistory, quotesOf, yesMidBps, type MarketCtx } from "./market";
import { ARCHETYPES, MIX, archetypeOrder, generatePopulation, type TraderProfile } from "./population";
import { rngFrom } from "./rng";
import { capShares, decide, underwrite, type Holdings, type SimAction } from "./strategy";

function catalogBook(entryIndex = 0): BookOrder[] {
  const entry = CATALOG[entryIndex]!;
  let book: Array<BookOrder & { isBot: boolean }> = [];
  let seq = 1n;
  for (const p of entry.ladder) {
    const fresh = quotesToOrders(clampQuotes(p, targetQuotes(p, 0n, false), book, { skewEnabled: false }), seq);
    seq += BigInt(fresh.length);
    book = [...book, ...fresh];
  }
  return book;
}

function ctxOf(book: BookOrder[], over: Partial<MarketCtx> = {}): MarketCtx {
  const quotes = quotesOf(book);
  return { hazard: "wildfire", market: "M", anchorBps: CATALOG[0]!.ladder[0]!.refBps, book, quotes, midBps: yesMidBps(quotes), signal: 0, momentum: () => undefined, chainNow: 1_000n, ...over };
}

describe("population", () => {
  it("100 traders in the specified mix, deterministic from the seed", () => {
    const pop = generatePopulation("s", 100);
    for (const a of ARCHETYPES) expect(pop.filter((p) => p.archetype === a).length).toBe(MIX[a]);
    expect(generatePopulation("s", 100)).toEqual(pop);
    expect(generatePopulation("t", 100)[0]!.ratePerMin).not.toBe(pop[0]!.ratePerMin);
    expect(new Set(pop.map((p) => p.id)).size).toBe(100);
  });

  it("any prefix is mixed (ramping 20 → 50 keeps every major archetype)", () => {
    const first20 = new Set(archetypeOrder(100).slice(0, 20));
    for (const a of ["retail", "homeowner", "risk", "quant"] as const) expect(first20.has(a)).toBe(true);
  });

  it("capital ranges and total", () => {
    const pop = generatePopulation("metrex-v7", 100);
    const total = pop.reduce((s, p) => s + p.capital, 0n) / MUSD_UNIT;
    expect(total).toBeGreaterThan(2_000_000n);
    expect(total).toBeLessThan(6_000_000n);
    for (const p of pop.filter((x) => x.archetype === "large")) expect(p.capital).toBeGreaterThanOrEqual(250_000n * MUSD_UNIT);
  });
});

describe("bulletins", () => {
  it("deterministic, published inside the window, roughly unbiased", () => {
    const day = 24 * 60 * 60_000;
    const a = bulletinsBetween("s", "wildfire", 0, day);
    expect(bulletinsBetween("s", "wildfire", 0, day)).toEqual(a);
    expect(a.length).toBeGreaterThan(20);
    for (const b of a) expect(b.headline.startsWith("Simulated bulletin")).toBe(true);
    const many = (["wildfire", "hurricane", "earthquake", "tornado"] as const).flatMap((h) => bulletinsBetween("s", h, 0, 20 * day));
    const ups = many.filter((b) => b.impact > 0).length / many.length;
    expect(ups).toBeGreaterThan(0.4);
    expect(ups).toBeLessThan(0.6);
    expect(Math.abs(signalAt("s", "wildfire", day))).toBeLessThan(5 * DEFAULT_INFO.impact[1]);
  });
});

describe("market view", () => {
  it("mid from both books and momentum from history", () => {
    const book = catalogBook();
    const mid = yesMidBps(quotesOf(book))!;
    expect(mid).toBeGreaterThan(74);
    expect(mid).toBeLessThan(86);
    const h = new MidHistory();
    h.push(0, 80);
    h.push(5 * 60_000, 100);
    expect(h.change(5 * 60_000, 10)).toBeUndefined();
    expect(h.change(5 * 60_000, 4)).toBeGreaterThan(0);
  });
});

function check(p: TraderProfile, a: SimAction, h: Holdings, book: BookOrder[]) {
  const q = quotesOf(book);
  if (a.kind === "take") {
    expect(a.qty > 0n).toBe(true);
    if (a.side === OrderSide.Sell) expect(a.qty <= (a.outcome === Outcome.Yes ? h.yes : h.no)).toBe(true);
    else {
      const ask = (a.outcome === Outcome.Yes ? q.yesAsk : q.noAsk)!;
      expect(a.worstPriceBps).toBeGreaterThanOrEqual(ask.priceBps);
      // Worst-case cost is funded.
      expect(a.qty * BigInt(a.worstPriceBps) * QUOTE_PER_SHARE_BPS <= h.musd).toBe(true);
    }
  }
  if (a.kind === "limit") {
    expect(p.postsLimits).toBe(true);
    const ask = a.outcome === Outcome.Yes ? q.yesAsk : q.noAsk;
    if (ask) expect(a.priceBps).toBeLessThan(ask.priceBps); // never crosses
    expect(a.qty <= MAX_ORDER_QTY).toBe(true); // place_order's on-chain bound
    expect(a.qty * BigInt(a.priceBps) * QUOTE_PER_SHARE_BPS <= h.musd).toBe(true);
  }
}

describe("decisions", () => {
  it("every archetype only takes what it can fund or holds, and limits never cross", () => {
    const pop = generatePopulation("check", 100);
    const rng = rngFrom("decisions");
    const counts = new Map<string, number>();
    for (let round = 0; round < 40; round++) {
      for (const [i] of CATALOG.entries()) {
        const book = catalogBook(i);
        for (const p of pop) {
          const h: Holdings = { musd: p.capital, yes: round % 3 === 0 ? 5_000n : 0n, no: round % 4 === 0 ? 3_000n : 0n, own: [] };
          const signal = rng.normal(0, 0.5);
          const a = decide({ p, me: "trader", ctx: ctxOf(book, { hazard: CATALOG[i]!.hazard, signal, anchorBps: CATALOG[i]!.ladder[0]!.refBps, momentum: () => rng.normal(0, 0.2) }), h, mem: {}, rng, nowMs: round * 60_000 });
          if (!a) continue;
          counts.set(`${p.archetype}:${a.kind}`, (counts.get(`${p.archetype}:${a.kind}`) ?? 0) + 1);
          check(p, a, h, book);
        }
      }
    }
    // Every archetype acts in some scenario, and both order types occur.
    for (const a of ARCHETYPES) expect([...counts.keys()].some((k) => k.startsWith(`${a}:`))).toBe(true);
    expect([...counts.keys()].some((k) => k.endsWith(":limit"))).toBe(true);
    expect([...counts.keys()].some((k) => k.endsWith(":take"))).toBe(true);
  });

  it("no cash, no buys", () => {
    const pop = generatePopulation("check", 100);
    const rng = rngFrom("x");
    for (const p of pop) {
      const a = decide({ p, me: "t", ctx: ctxOf(catalogBook(), { signal: 2 }), h: { musd: 0n, yes: 0n, no: 0n, own: [] }, mem: {}, rng, nowMs: 0 });
      if (a?.kind === "take") expect(a.side).toBe(OrderSide.Sell);
      expect(a?.kind === "limit").toBe(false);
    }
  });

  it("quants take complement arbitrage when asks sum below 1 mUSD", () => {
    const quant = generatePopulation("check", 100).find((p) => p.archetype === "quant")!;
    const book: BookOrder[] = [
      { id: "y", maker: "m1", outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 100, remaining: 1_000n, seq: 1n },
      { id: "n", maker: "m2", outcome: Outcome.No, side: OrderSide.Sell, priceBps: 9_800, remaining: 800n, seq: 2n },
    ];
    const a = decide({ p: quant, me: "q", ctx: ctxOf(book), h: { musd: 10_000n * MUSD_UNIT, yes: 0n, no: 0n, own: [] }, mem: {}, rng: rngFrom("q"), nowMs: 0 });
    expect(a).toMatchObject({ kind: "buyMerge", qty: 800n, yesWorstBps: 100, noWorstBps: 9_800 });
    expect(100 + 9_800).toBeLessThan(BPS_DENOMINATOR);
  });

  it("share holdings are capped per outcome, so sub-cent prices cannot ask makers for millions of shares", () => {
    const pop = generatePopulation("check", 100);
    for (const p of pop) expect(p.maxShares).toBeLessThanOrEqual(p.capital / MUSD_UNIT * 10n);
    const rng = rngFrom("cap");
    for (const p of pop) {
      for (const [i] of CATALOG.entries()) {
        const h: Holdings = { musd: p.capital, yes: p.maxShares, no: p.maxShares, own: [] };
        const a = decide({ p, me: "t", ctx: ctxOf(catalogBook(i), { hazard: CATALOG[i]!.hazard, signal: rng.normal(0, 1), anchorBps: CATALOG[i]!.ladder[0]!.refBps }), h, mem: {}, rng, nowMs: 0 });
        if (a && (a.kind === "take" || a.kind === "limit")) expect(a.side).toBe(OrderSide.Sell);
      }
    }
    const retail = pop.find((p) => p.archetype === "retail")!;
    const buy: SimAction = { kind: "take", outcome: Outcome.Yes, side: OrderSide.Buy, qty: 10_000_000n, worstPriceBps: 20, reason: "t" };
    const resting = { address: "o", maker: "t", market: "M", outcome: Outcome.Yes, side: OrderSide.Buy, priceBps: 10, originalQty: 1_000n, remainingQty: 1_000n, seq: 1n, expiresAt: 0n, createdAt: 0n } as unknown as Holdings["own"][number];
    expect(capShares({ p: retail, h: { musd: retail.capital, yes: 0n, no: 0n, own: [resting] } }, buy)).toMatchObject({ qty: retail.maxShares - 1_000n });
  });

  it("homeowner coverage targets are human-sized and risk investors lean NO", () => {
    const pop = generatePopulation("check", 100);
    const homeowners = pop.filter((p) => p.archetype === "homeowner");
    const coverage = homeowners.reduce((a, p) => a + p.coverageShares, 0n);
    expect(coverage).toBeLessThan(1_000_000n);
    const risk = pop.filter((p) => p.archetype === "risk");
    const meanBias = risk.flatMap((p) => Object.values(p.bias)).reduce((a, b) => a + b, 0) / (risk.length * 4);
    expect(meanBias).toBeLessThan(-0.2);
  });

  it("a trader never takes its own resting order", () => {
    const retail = generatePopulation("check", 100).filter((p) => p.archetype === "retail");
    const own: BookOrder[] = catalogBook().map((o) => ({ ...o, maker: "me" }));
    for (const p of retail) {
      const a = decide({ p, me: "me", ctx: ctxOf(own, { signal: 3 }), h: { musd: p.capital, yes: 0n, no: 0n, own: [] }, mem: {}, rng: rngFrom(p.id), nowMs: 0 });
      expect(a).toBeNull();
    }
  });
});

const SRC = __dirname;
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.ts$/.test(n) ? [p] : [];
  });
const specifiers = (text: string): string[] =>
  [...text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g)].map((m) => m[1] as string);

describe("information isolation (spec-v2 §8.4)", () => {
  it("no simulator file imports @metrex/geo, the oracle, data/ or the root server entry", () => {
    const bad: string[] = [];
    for (const f of files(SRC)) {
      if (f.endsWith("sim.test.ts")) continue;
      for (const s of specifiers(readFileSync(f, "utf8"))) {
        if (/^@metrex\/geo(\/|$)/.test(s) || /oracle/.test(s) || /(^|\/)data(\/|$)/.test(s) || s === "@metrex/server" || (s.startsWith("@metrex/server/") && s !== "@metrex/server/exchange")) {
          bad.push(`${relative(SRC, f)} → ${s}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("refuses to start with oracle data configured", () => {
    expect(() => assertNoOracleData({ METREX_ORACLE_DATA_DIR: "/x" })).toThrow(/Refusing/);
    expect(() => assertNoOracleData({})).not.toThrow();
  });
});

describe("underwriting (spec-multiperil §7.7)", () => {
  const risk = () => generatePopulation("metrex-v7", 100).find((p) => p.archetype === "risk")!;
  const h: Holdings = { musd: 50_000n * MUSD_UNIT, yes: 0n, no: 0n, own: [] };
  const bid = (priceBps: number, remaining = 20_000n): BookOrder => ({ id: "home", maker: "homeowner", outcome: Outcome.Yes, side: OrderSide.Buy, priceBps, remaining, seq: 1n });
  const view = (book: BookOrder[]) => ({ p: risk(), q: quotesOf(book), h, ctx: ctxOf(book), rng: rngFrom("u") });

  it("sells YES into a premium bid well above belief, within the bid and the holding cap", () => {
    const L = Math.log(80 / 9_920); // belief at the 0.80¢ baseline
    const a = underwrite(view([bid(400)]), L);
    expect(a?.kind).toBe("underwrite");
    if (a?.kind !== "underwrite") return;
    expect(a.yesWorstBps).toBe(400);
    expect(a.qty).toBeGreaterThan(0n);
    expect(a.qty).toBeLessThanOrEqual(20_000n);
    expect(a.qty).toBeLessThanOrEqual(risk().maxShares);
  });

  it("leaves a bid at or below belief alone", () => {
    const L = Math.log(80 / 9_920);
    expect(underwrite(view([bid(80)]), L)).toBeNull();
    expect(underwrite(view([bid(60)]), L)).toBeNull();
    expect(underwrite(view([]), L)).toBeNull();
  });
});
