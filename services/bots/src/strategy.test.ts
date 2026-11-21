import { describe, expect, it } from "vitest";
import { MUSD_UNIT } from "@metrex/shared";
import { BOTS, type BotParams } from "./params";
import {
  botExposure,
  offerCoverage,
  planCleanup,
  planListings,
  planNewOffers,
  planRequotes,
  planTick,
  RequoteLimiter,
  riskListingPrice,
  type MarketLite,
  type OfferLite,
} from "./strategy";

const U = MUSD_UNIT;
const [A, B, C] = BOTS as [BotParams, BotParams, BotParams];
const BOT = "botA";
const RICH = { musd: 1_000_000n * U, solLamports: 2_000_000_000n };

function mkt(key: string, over: Partial<MarketLite> = {}): MarketLite {
  return {
    key,
    homeowner: "home",
    status: "open",
    coverageTarget: 10_000n * U,
    coverageActivated: 0n,
    createdAt: 1n,
    ...over,
  };
}

let n = 0;
function off(market: string, over: Partial<OfferLite> = {}): OfferLite {
  const coverage = over.coverage ?? 4_000n * U;
  const bps = over.premiumBps ?? 400;
  const premium = (coverage * BigInt(bps)) / 10_000n;
  return {
    key: `offer${n++}`,
    market,
    underwriter: BOT,
    coverage,
    premiumBps: bps,
    premium,
    collateral: coverage - premium,
    riskHolder: "11111111111111111111111111111111",
    status: "open",
    ...over,
  };
}

const mapOf = (...ms: MarketLite[]) => new Map(ms.map((m) => [m.key, m]));

describe("offerCoverage (§7)", () => {
  it("matches the §4.3 worked example sizes", () => {
    expect(offerCoverage(A, 10_000n * U, 0n)).toBe(4_000n * U);
    expect(offerCoverage(B, 10_000n * U, 0n)).toBe(3_000n * U);
    expect(offerCoverage(C, 10_000n * U, 0n)).toBe(3_000n * U);
  });

  it("applies the per-market cap", () => {
    expect(offerCoverage(A, 1_000_000n * U, 0n)).toBe(50_000n * U);
    expect(offerCoverage(C, 1_000_000n * U, 0n)).toBe(20_000n * U);
  });

  it("applies the remaining exposure cap", () => {
    expect(offerCoverage(A, 100_000n * U, 190_000n * U)).toBe(10_000n * U);
    expect(offerCoverage(A, 100_000n * U, 200_000n * U)).toBeNull();
    expect(offerCoverage(A, 100_000n * U, 250_000n * U)).toBeNull();
  });

  it("rounds down to whole mUSD and enforces MIN_COVERAGE", () => {
    // 40% of 33.333333 mUSD = 13.3333332 → 13 mUSD
    expect(offerCoverage(A, 33_333_333n, 0n)).toBe(13n * U);
    // 30% of 30 mUSD = 9 < 10 → none
    expect(offerCoverage(B, 30n * U, 0n)).toBeNull();
    expect(offerCoverage(A, 100_000n * U, 199_995n * U)).toBeNull();
  });
});

describe("botExposure", () => {
  it("separates locked offers from held risk, including purchases and sales", () => {
    const markets = mapOf(mkt("m1"), mkt("m2", { status: "closed" }), mkt("m3", { status: "resolvedNo" }), mkt("m4", { status: "voided" }));
    const offers = [
      off("m1", { coverage: 1_000n * U }),
      off("m1", { coverage: 2_000n * U, status: "accepted", riskHolder: BOT }),
      off("m2", { coverage: 3_000n * U, status: "accepted", underwriter: "other", riskHolder: BOT }),
      off("m2", { coverage: 500n * U, status: "open" }),
      off("m1", { coverage: 7_000n * U, status: "accepted", riskHolder: "buyer" }),
      off("m3", { coverage: 8_000n * U, status: "accepted", riskHolder: BOT }),
      off("m4", { coverage: 9_000n * U, status: "accepted", riskHolder: BOT }),
    ];
    expect(botExposure(BOT, offers, markets)).toEqual({
      offeredCoverage: 1_000n * U,
      committedCollateral: 1_440n * U,
      heldRiskCoverage: 5_000n * U,
    });
  });
});

describe("planNewOffers (§7)", () => {
  const base = { params: A, bot: BOT, botOffers: [], exposure: 0n, wallet: RICH, inFlight: new Set<string>() };

  it("sizes the quote against a partially filled market's remaining capacity", () => {
    const openMarkets = [mkt("small", { coverageActivated: 9_949n * U + 1n })];
    expect(planNewOffers({ ...base, openMarkets })).toMatchObject([
      { kind: "place", market: "small", coverage: 51n * U - 1n },
    ]);
  });

  it("offers once on each open market", () => {
    const acts = planNewOffers({ ...base, openMarkets: [mkt("m1"), mkt("m2")] });
    expect(acts).toEqual([
      { kind: "place", market: "m1", coverage: 4_000n * U, bps: 400, collateral: 3_840n * U },
      { kind: "place", market: "m2", coverage: 4_000n * U, bps: 400, collateral: 3_840n * U },
    ]);
  });

  it("is idempotent: skips markets with any existing offer from this bot, or in flight", () => {
    const acts = planNewOffers({
      ...base,
      openMarkets: [mkt("m1"), mkt("m2"), mkt("m3")],
      botOffers: [off("m1", { status: "cancelled" })],
      inFlight: new Set(["m2"]),
    });
    expect(acts.map((a) => a.market)).toEqual(["m3"]);
  });

  it("never underwrites its own market or a funded/non-open market", () => {
    const acts = planNewOffers({
      ...base,
      openMarkets: [
        mkt("own", { homeowner: BOT }),
        mkt("funded", { coverageActivated: 10_000n * U }),
        mkt("closed", { status: "closed" }),
      ],
    });
    expect(acts).toEqual([]);
  });

  it("skips (with a reason) on low mUSD or low SOL", () => {
    const lowMusd = planNewOffers({ ...base, openMarkets: [mkt("m1")], wallet: { ...RICH, musd: 3_839n * U } });
    expect(lowMusd).toEqual([{ kind: "skip", market: "m1", reason: "mUSD below required collateral" }]);
    const lowSol = planNewOffers({ ...base, openMarkets: [mkt("m1")], wallet: { ...RICH, solLamports: 9_999_999n } });
    expect(lowSol).toEqual([{ kind: "skip", market: "m1", reason: "SOL below 0.01" }]);
  });

  it("budgets balance and exposure across markets in one tick", () => {
    const acts = planNewOffers({
      ...base,
      openMarkets: [mkt("m1", { createdAt: 2n }), mkt("m2", { createdAt: 1n })],
      wallet: { ...RICH, musd: 5_000n * U },
    });
    expect(acts).toEqual([
      { kind: "place", market: "m2", coverage: 4_000n * U, bps: 400, collateral: 3_840n * U },
      { kind: "skip", market: "m1", reason: "mUSD below required collateral" },
    ]);
    const capped = planNewOffers({
      ...base,
      openMarkets: [mkt("a", { coverageTarget: 400_000n * U }), mkt("b", { coverageTarget: 400_000n * U })],
      exposure: 160_000n * U,
    });
    expect(capped).toEqual([
      { kind: "place", market: "a", coverage: 40_000n * U, bps: 400, collateral: 38_400n * U },
      { kind: "skip", market: "b", reason: "exposure cap reached or size below minimum" },
    ]);
  });
});

describe("planCleanup (§7)", () => {
  it("cancels this bot's open offers once the market leaves Open", () => {
    const o1 = off("closed");
    const o2 = off("resolved");
    const o3 = off("open");
    const o4 = off("closed", { status: "accepted" });
    const acts = planCleanup(
      [o1, o2, o3, o4],
      mapOf(mkt("closed", { status: "closed" }), mkt("resolved", { status: "resolvedYes" }), mkt("open")),
    );
    expect(acts).toEqual([
      { kind: "cancel", offer: o1.key, market: "closed", reason: "market closed" },
      { kind: "cancel", offer: o2.key, market: "resolved", reason: "market resolvedYes" },
    ]);
  });
});

describe("planRequotes (§7.1)", () => {
  const others = new Set(["botB", "botC"]);
  const run = (offers: OfferLite[], over: Partial<Parameters<typeof planRequotes>[0]> = {}) =>
    planRequotes({
      params: A,
      bot: BOT,
      openMarkets: [mkt("m1")],
      openOffers: offers,
      ignoreUnderwriters: others,
      limiter: new RequoteLimiter(),
      now: 100_000,
      ...over,
    });

  it("re-places at undercut − step when another wallet undercuts", () => {
    const mine = off("m1", { premiumBps: 400 });
    const judge = off("m1", { underwriter: "judge", premiumBps: 390 });
    expect(run([mine, judge])).toEqual([
      { kind: "requote", market: "m1", cancelOffer: mine.key, coverage: mine.coverage, fromBps: 400, bps: 380, undercutBps: 390 },
    ]);
  });

  it("never goes below the floor, and stops at it", () => {
    const mine = off("m1", { premiumBps: 360 });
    const judge = off("m1", { underwriter: "judge", premiumBps: 300 });
    expect(run([mine, judge])[0]).toMatchObject({ bps: 350 });
    const atFloor = off("m1", { premiumBps: 350 });
    expect(run([atFloor, judge])).toEqual([]);
  });

  it("ignores equal or higher rivals, other bots, other markets and funded markets", () => {
    const mine = off("m1", { premiumBps: 400 });
    expect(run([mine, off("m1", { underwriter: "judge", premiumBps: 400 })])).toEqual([]);
    expect(run([mine, off("m1", { underwriter: "botB", premiumBps: 300 })])).toEqual([]);
    expect(run([mine, off("m2", { underwriter: "judge", premiumBps: 300 })])).toEqual([]);
    expect(
      run([mine, off("m1", { underwriter: "judge", premiumBps: 300 })], {
        openMarkets: [mkt("m1", { coverageActivated: 10_000n * U })],
      }),
    ).toEqual([]);
  });

  it("does nothing without an open offer of its own", () => {
    expect(run([off("m1", { underwriter: "judge", premiumBps: 300 })])).toEqual([]);
  });

  it("requotes the bot's best (lowest) offer", () => {
    const hi = off("m1", { premiumBps: 450 });
    const lo = off("m1", { premiumBps: 420 });
    const acts = run([hi, lo, off("m1", { underwriter: "judge", premiumBps: 410 })]);
    expect(acts[0]).toMatchObject({ cancelOffer: lo.key, fromBps: 420, bps: 400 });
  });

  it("rate-limits: one per bot per market per 5 s, 20 per market", () => {
    const mine = off("m1", { premiumBps: 400 });
    const judge = off("m1", { underwriter: "judge", premiumBps: 390 });
    const limiter = new RequoteLimiter();
    limiter.record(BOT, "m1", 100_000);
    expect(run([mine, judge], { limiter, now: 104_999 })).toEqual([{ kind: "skip", market: "m1", reason: "requote cooldown" }]);
    expect(run([mine, judge], { limiter, now: 105_000 })[0]).toMatchObject({ kind: "requote" });
    for (let i = 0; i < 19; i++) limiter.record("botB", "m1", 0);
    expect(limiter.count("m1")).toBe(20);
    expect(run([mine, judge], { limiter, now: 1_000_000 })).toEqual([
      { kind: "skip", market: "m1", reason: "requote limit 20 reached" },
    ]);
  });

  it("walks down to the floor through repeated judge undercuts", () => {
    const limiter = new RequoteLimiter();
    let mine = off("m1", { premiumBps: A.bps });
    let now = 0;
    const seen: number[] = [];
    for (let judgeBps = 395; judgeBps > 300; judgeBps -= 15) {
      const acts = run([mine, off("m1", { underwriter: "judge", premiumBps: judgeBps })], { limiter, now });
      const rq = acts.find((a) => a.kind === "requote");
      if (rq && rq.kind === "requote") {
        limiter.record(BOT, "m1", now);
        seen.push(rq.bps);
        mine = off("m1", { premiumBps: rq.bps });
      }
      now += 5_000;
    }
    expect(seen.every((b) => b >= A.floorBps)).toBe(true);
    expect(seen[seen.length - 1]).toBe(A.floorBps);
  });
});

describe("planListings (§7.1)", () => {
  it("prices Risk at collateral + 50% of premium", () => {
    expect(riskListingPrice({ collateral: 3_840n * U, premium: 160n * U }, 50n)).toBe(3_920n * U);
    expect(riskListingPrice({ collateral: 9n, premium: 3n }, 50n)).toBe(10n);
  });

  it("lists held accepted positions on Open/Closed markets once; cancels listings when final", () => {
    const held = off("m1", { status: "accepted", riskHolder: BOT });
    const sold = off("m1", { status: "accepted", riskHolder: "buyer" });
    const closedHeld = off("m2", { status: "accepted", riskHolder: BOT });
    const alreadyListed = off("m1", { status: "accepted", riskHolder: BOT });
    const finalListed = off("m3", { status: "accepted", riskHolder: BOT });
    const acts = planListings({
      bot: BOT,
      botOffers: [held, sold, closedHeld, alreadyListed, finalListed],
      markets: mapOf(mkt("m1"), mkt("m2", { status: "closed" }), mkt("m3", { status: "resolvedNo" })),
      riskListings: new Map([
        [alreadyListed.key, "L1"],
        [finalListed.key, "L2"],
      ]),
      premiumPct: 50n,
      inFlight: new Set(),
    });
    expect(acts).toEqual([
      { kind: "list", offer: held.key, market: "m1", price: riskListingPrice(held, 50n) },
      { kind: "cancelListing", listing: "L2", offer: finalListed.key, market: "m3" },
    ]);
  });
});

describe("planTick", () => {
  it("core mode: cleanup first, then new offers, no requotes or listings", () => {
    const stale = off("closed");
    const acts = planTick({
      params: A,
      bot: BOT,
      openMarkets: [mkt("m1")],
      markets: mapOf(mkt("m1"), mkt("closed", { status: "closed" })),
      botOffers: [stale, off("m0", { status: "accepted", riskHolder: BOT })],
      wallet: RICH,
      inFlight: new Set(),
    });
    expect(acts.map((a) => a.kind)).toEqual(["cancel", "place"]);
  });

  it("tier 2: requote checks the extra collateral it needs", () => {
    const mine = off("m1", { premiumBps: 400 });
    const judge = off("m1", { underwriter: "judge", premiumBps: 390 });
    const input = {
      params: A,
      bot: BOT,
      openMarkets: [mkt("m1")],
      markets: mapOf(mkt("m1")),
      botOffers: [mine],
      inFlight: new Set<string>(),
      tier2: {
        openOffers: [mine, judge],
        ignoreUnderwriters: new Set<string>(),
        limiter: new RequoteLimiter(),
        riskListings: new Map<string, string>(),
        premiumPct: 50n,
        now: 0,
      },
    };
    // 4,000 @ 400 → K 3,840; @ 380 → K 3,848: needs 8 extra mUSD.
    expect(planTick({ ...input, wallet: { ...RICH, musd: 8n * U } }).map((a) => a.kind)).toEqual(["requote"]);
    expect(planTick({ ...input, wallet: { ...RICH, musd: 7n * U } })).toEqual([
      { kind: "skip", market: "m1", reason: "mUSD below extra collateral for requote" },
    ]);
  });
});
