// Pure bot decisions (spec §7, §7.1). No I/O: the worker feeds in chain state and executes
// the returned actions. Keys are base58 strings; amounts are bigint base units.

import { computeOfferTerms, MIN_COVERAGE, MUSD_UNIT, type MarketStatus, type OfferStatus } from "@metrex/shared";
import {
  MIN_SOL_LAMPORTS,
  REQUOTE_MAX_PER_MARKET,
  REQUOTE_MIN_INTERVAL_MS,
  type BotParams,
} from "./params";

export interface MarketLite {
  key: string;
  homeowner: string;
  status: MarketStatus;
  coverageTarget: bigint;
  coverageActivated: bigint;
  createdAt: bigint;
}

export interface OfferLite {
  key: string;
  market: string;
  underwriter: string;
  coverage: bigint;
  premiumBps: number;
  premium: bigint;
  collateral: bigint;
  riskHolder: string;
  status: OfferStatus;
}

export type Action =
  | { kind: "place"; market: string; coverage: bigint; bps: number; collateral: bigint }
  | { kind: "cancel"; offer: string; market: string; reason: string }
  | {
      kind: "requote";
      market: string;
      cancelOffer: string;
      coverage: bigint;
      fromBps: number;
      bps: number;
      undercutBps: number;
    }
  | { kind: "list"; offer: string; market: string; price: bigint }
  | { kind: "cancelListing"; listing: string; offer: string; market: string }
  | { kind: "skip"; market: string; reason: string };

const isUnresolved = (s: MarketStatus): boolean => s === "open" || s === "closed";
const isFunded = (m: MarketLite): boolean => m.coverageActivated >= m.coverageTarget;
const minBig = (...xs: bigint[]): bigint => xs.reduce((a, b) => (b < a ? b : a));

/**
 * §7: min(size% of target, per-market cap, remaining exposure cap), rounded down to whole
 * mUSD, ≥ MIN_COVERAGE (and ≤ target). Null when nothing valid can be offered.
 */
export function offerCoverage(p: BotParams, coverageTarget: bigint, exposure: bigint): bigint | null {
  const size = (coverageTarget * p.sizePct) / 100n;
  const remaining = p.totalExposureCap > exposure ? p.totalExposureCap - exposure : 0n;
  let c = minBig(size, p.perMarketCap, remaining, coverageTarget);
  c -= c % MUSD_UNIT;
  return c >= MIN_COVERAGE ? c : null;
}

/** Sum of coverage of this bot's Open + Accepted offers on unresolved (Open/Closed) markets. */
export function botExposure(botOffers: readonly OfferLite[], markets: ReadonlyMap<string, MarketLite>): bigint {
  let total = 0n;
  for (const o of botOffers) {
    if (o.status !== "open" && o.status !== "accepted") continue;
    const m = markets.get(o.market);
    if (m && isUnresolved(m.status)) total += o.coverage;
  }
  return total;
}

/** §7 cleanup: cancel unaccepted offers once their market has left Open. */
export function planCleanup(botOffers: readonly OfferLite[], markets: ReadonlyMap<string, MarketLite>): Action[] {
  const out: Action[] = [];
  for (const o of botOffers) {
    if (o.status !== "open") continue;
    const m = markets.get(o.market);
    if (m && m.status !== "open") {
      out.push({ kind: "cancel", offer: o.key, market: o.market, reason: `market ${m.status}` });
    }
  }
  return out;
}

export interface Wallet {
  musd: bigint;
  solLamports: bigint;
}

/** Shared-across-bots requote budget (§7.1). Pure state; the worker records successes. */
export class RequoteLimiter {
  private readonly last = new Map<string, number>();
  private readonly perMarket = new Map<string, number>();
  constructor(
    readonly minIntervalMs = REQUOTE_MIN_INTERVAL_MS,
    readonly maxPerMarket = REQUOTE_MAX_PER_MARKET,
  ) {}

  /** Null if allowed, else the reason. */
  blocked(bot: string, market: string, now: number): string | null {
    if ((this.perMarket.get(market) ?? 0) >= this.maxPerMarket) return `requote limit ${this.maxPerMarket} reached`;
    const t = this.last.get(`${bot}:${market}`);
    if (t !== undefined && now - t < this.minIntervalMs) return "requote cooldown";
    return null;
  }

  record(bot: string, market: string, now: number): void {
    this.last.set(`${bot}:${market}`, now);
    this.perMarket.set(market, (this.perMarket.get(market) ?? 0) + 1);
  }

  count(market: string): number {
    return this.perMarket.get(market) ?? 0;
  }
}

export interface RequoteInput {
  params: BotParams;
  bot: string;
  openMarkets: readonly MarketLite[];
  /** Every Open offer on Open markets, from all wallets. */
  openOffers: readonly OfferLite[];
  /** Wallets whose offers never trigger a requote (the other bots). */
  ignoreUnderwriters: ReadonlySet<string>;
  limiter: RequoteLimiter;
  now: number;
}

/**
 * §7.1: when another wallet's Open offer on an Open, not-yet-funded market undercuts the bot's
 * best Open offer, cancel it and re-place the same coverage at `undercut − step`, never below
 * the floor. Rate-limited per bot per market and per market.
 */
export function planRequotes(i: RequoteInput): Action[] {
  const out: Action[] = [];
  for (const m of i.openMarkets) {
    if (m.status !== "open" || isFunded(m)) continue;
    const here = i.openOffers.filter((o) => o.market === m.key && o.status === "open");
    const mine = here.filter((o) => o.underwriter === i.bot);
    if (mine.length === 0) continue;
    const best = mine.reduce((a, b) => (b.premiumBps < a.premiumBps ? b : a));
    const rivals = here.filter((o) => o.underwriter !== i.bot && !i.ignoreUnderwriters.has(o.underwriter));
    if (rivals.length === 0) continue;
    const undercut = Math.min(...rivals.map((o) => o.premiumBps));
    if (undercut >= best.premiumBps) continue;
    const target = Math.max(undercut - i.params.stepBps, i.params.floorBps);
    if (target >= best.premiumBps) continue; // already at the floor
    const blocked = i.limiter.blocked(i.bot, m.key, i.now);
    if (blocked) {
      out.push({ kind: "skip", market: m.key, reason: blocked });
      continue;
    }
    out.push({
      kind: "requote",
      market: m.key,
      cancelOffer: best.key,
      coverage: best.coverage,
      fromBps: best.premiumBps,
      bps: target,
      undercutBps: undercut,
    });
  }
  return out;
}

export interface NewOfferInput {
  params: BotParams;
  bot: string;
  openMarkets: readonly MarketLite[];
  /** All of this bot's offers (any status, any market). */
  botOffers: readonly OfferLite[];
  exposure: bigint;
  wallet: Wallet;
  /** Markets with a placement already in flight. */
  inFlight: ReadonlySet<string>;
}

/** §7: one offer per market the bot hasn't offered on, with balance/SOL checks. */
export function planNewOffers(i: NewOfferInput): Action[] {
  const out: Action[] = [];
  const offered = new Set(i.botOffers.map((o) => o.market));
  let exposure = i.exposure;
  let musd = i.wallet.musd;
  const markets = [...i.openMarkets].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.key < b.key ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1,
  );
  for (const m of markets) {
    if (m.status !== "open" || offered.has(m.key) || i.inFlight.has(m.key)) continue;
    if (m.homeowner === i.bot) continue; // SelfUnderwriting
    if (isFunded(m)) continue;
    const coverage = offerCoverage(i.params, m.coverageTarget, exposure);
    if (coverage === null) {
      out.push({ kind: "skip", market: m.key, reason: "exposure cap reached or size below minimum" });
      continue;
    }
    const { collateral, premium } = computeOfferTerms(coverage, i.params.bps);
    if (premium < 1n) {
      out.push({ kind: "skip", market: m.key, reason: "premium rounds to zero" });
      continue;
    }
    if (i.wallet.solLamports < MIN_SOL_LAMPORTS) {
      out.push({ kind: "skip", market: m.key, reason: "SOL below 0.01" });
      continue;
    }
    if (musd < collateral) {
      out.push({ kind: "skip", market: m.key, reason: "mUSD below required collateral" });
      continue;
    }
    musd -= collateral;
    exposure += coverage;
    out.push({ kind: "place", market: m.key, coverage, bps: i.params.bps, collateral });
  }
  return out;
}

/** §7.1 Risk-side listing price: collateral + pct% of premium (floor). */
export function riskListingPrice(o: Pick<OfferLite, "collateral" | "premium">, premiumPct: bigint): bigint {
  return o.collateral + (o.premium * premiumPct) / 100n;
}

export interface ListingInput {
  bot: string;
  botOffers: readonly OfferLite[];
  markets: ReadonlyMap<string, MarketLite>;
  /** Offer keys this bot already has a Risk listing for, mapped to the listing key. */
  riskListings: ReadonlyMap<string, string>;
  premiumPct: bigint;
  inFlight: ReadonlySet<string>;
}

/**
 * §7.1: list the Risk side of each accepted position the bot still holds while trading is
 * allowed (Open/Closed); cancel its listings once the market is final (recovers rent).
 */
export function planListings(i: ListingInput): Action[] {
  const out: Action[] = [];
  const byKey = new Map(i.botOffers.map((o) => [o.key, o]));
  for (const o of i.botOffers) {
    if (o.status !== "accepted" || o.riskHolder !== i.bot) continue;
    const m = i.markets.get(o.market);
    if (!m || !isUnresolved(m.status)) continue;
    if (i.riskListings.has(o.key) || i.inFlight.has(o.key)) continue;
    const price = riskListingPrice(o, i.premiumPct);
    if (price < 1n) continue;
    out.push({ kind: "list", offer: o.key, market: o.market, price });
  }
  for (const [offerKey, listingKey] of i.riskListings) {
    const o = byKey.get(offerKey);
    const m = o ? i.markets.get(o.market) : undefined;
    if (o && m && !isUnresolved(m.status) && !i.inFlight.has(offerKey)) {
      out.push({ kind: "cancelListing", listing: listingKey, offer: offerKey, market: o.market });
    }
  }
  return out;
}

export interface TickInput {
  params: BotParams;
  bot: string;
  openMarkets: readonly MarketLite[];
  /** Markets referenced by this bot's offers (plus open markets). */
  markets: ReadonlyMap<string, MarketLite>;
  botOffers: readonly OfferLite[];
  wallet: Wallet;
  inFlight: ReadonlySet<string>;
  tier2?: {
    openOffers: readonly OfferLite[];
    ignoreUnderwriters: ReadonlySet<string>;
    limiter: RequoteLimiter;
    riskListings: ReadonlyMap<string, string>;
    premiumPct: bigint;
    now: number;
  };
}

/**
 * One bot's actions for a tick, in execution order: cleanup cancels, then (Tier 2) requotes
 * and listings, then new offers. Requotes are budgeted against mUSD before new offers.
 */
export function planTick(i: TickInput): Action[] {
  const actions: Action[] = planCleanup(i.botOffers, i.markets);
  let wallet = i.wallet;
  if (i.tier2) {
    const rq = planRequotes({
      params: i.params,
      bot: i.bot,
      openMarkets: i.openMarkets,
      openOffers: i.tier2.openOffers,
      ignoreUnderwriters: i.tier2.ignoreUnderwriters,
      limiter: i.tier2.limiter,
      now: i.tier2.now,
    });
    let musd = wallet.musd;
    for (const a of rq) {
      if (a.kind !== "requote") {
        actions.push(a);
        continue;
      }
      if (i.inFlight.has(a.market)) continue;
      const old = i.botOffers.find((o) => o.key === a.cancelOffer);
      const next = computeOfferTerms(a.coverage, a.bps);
      const extra = old && next.collateral > old.collateral ? next.collateral - old.collateral : 0n;
      if (wallet.solLamports < MIN_SOL_LAMPORTS) {
        actions.push({ kind: "skip", market: a.market, reason: "SOL below 0.01 (requote)" });
        continue;
      }
      if (musd < extra) {
        actions.push({ kind: "skip", market: a.market, reason: "mUSD below extra collateral for requote" });
        continue;
      }
      musd -= extra;
      actions.push(a);
    }
    wallet = { ...wallet, musd };
    actions.push(
      ...planListings({
        bot: i.bot,
        botOffers: i.botOffers,
        markets: i.markets,
        riskListings: i.tier2.riskListings,
        premiumPct: i.tier2.premiumPct,
        inFlight: i.inFlight,
      }),
    );
  }
  actions.push(
    ...planNewOffers({
      params: i.params,
      bot: i.bot,
      openMarkets: i.openMarkets,
      botOffers: i.botOffers,
      exposure: botExposure(i.botOffers, i.markets),
      wallet,
      inFlight: i.inFlight,
    }),
  );
  return actions;
}
