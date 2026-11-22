// §7.5 read API for the v2 exchange, framework-agnostic (standard Request/Response). Reads the chain
// directly with a short in-memory cache for books, and reads finalized receipts from the shared
// local trade journal.

import { PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BN } from "@anchor-lang/core";
import { CATALOG, HAZARD_LABEL, LISTINGS, buildLedger, catalogByScenario, isHomeProperty, findMarketPda, findRoundPda, headlinePrice, marketBooks, Outcome, type LedgerEvent, type OutcomeBook } from "@metrex/exchange";
import { keyDir, loadKeypair, parsePublicKey, type KeypairName } from "../env";
import { getRpc } from "../rpc";
import {
  decodeMarketAccount,
  fetchPropertyIds,
  fetchExchangeConfig,
  fetchExchangeMarket,
  fetchMarketsOfRound,
  fetchOrders,
  fetchProperty,
  fetchRound,
  tokenBalance,
  type ConfigView,
  type MarketView,
  type PropertyView,
  type RoundView,
} from "../exchange/accounts";
import { BookCache, ExchangeStateLoader, type ExchangeState, type MarketBookSnapshot } from "../exchange/book";
import { readHeartbeat } from "../exchange/heartbeat";
import { exchangeProgramId, getExchangeProgram } from "../exchange/program";
import { TradeStore, tradeStorePath } from "../exchange/trade-store";
import { tradeDecoder } from "../exchange/trades";
import { badRequest, HttpError, notFound, unavailable } from "./errors";
import { homesOfScenario } from "../demo/homes";

const NO_STORE = { "cache-control": "no-store" } as const;

/** JSON with bigint as decimal strings and keys as base58. */
export function toJsonValue(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v instanceof PublicKey) return v.toBase58();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (Array.isArray(v)) return v.map(toJsonValue);
  if (v instanceof Map) return Object.fromEntries([...v.entries()].map(([k, x]) => [String(k), toJsonValue(x)]));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toJsonValue(x)]));
  return v;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(toJsonValue(body)), { status, headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE } });

async function run(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await fn());
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error("[api] exchange read failed:", e instanceof Error ? e.message : String(e));
    return json({ error: "Exchange data unavailable", code: "unavailable" }, 503);
  }
}

let configCache: { at: number; value: ConfigView } | undefined;
async function config(): Promise<ConfigView> {
  if (configCache && Date.now() - configCache.at < 10_000) return configCache.value;
  const c = await getRpc().run((conn) => fetchExchangeConfig(getExchangeProgram(conn)));
  if (!c) throw unavailable("Exchange is not configured on this cluster");
  configCache = { at: Date.now(), value: c };
  return c;
}

// Every book of the recent rounds from one cached loader: about three getMultipleAccounts per
// refresh however many markets and browsers poll (hosted RPC tiers cap getProgramAccounts at about
// one a second). Concurrent requests share one refresh.
const STATE_TTL_MS = 1_500;
const loader = new ExchangeStateLoader();
let stateCache: { at: number; value: Promise<ExchangeState | null> } | undefined;
function liveState(): Promise<ExchangeState | null> {
  if (!stateCache || Date.now() - stateCache.at > STATE_TTL_MS) {
    const value = getRpc().run((c) => loader.load(c));
    stateCache = { at: Infinity, value };
    void value.then(() => {
      if (stateCache?.value === value) stateCache.at = Date.now();
    }, () => undefined);
    value.catch(() => {
      if (stateCache?.value === value) stateCache = undefined;
    });
  }
  return stateCache.value;
}

/** Drops the cached state so the next read sees a just-created market. */
export function forgetState(): void {
  stateCache = undefined;
}

let books: BookCache | undefined;
async function bookCache(): Promise<BookCache> {
  const c = await config();
  books ??= new BookCache(() => getRpc().connection, c.collateralMint);
  return books;
}

/** A market's snapshot: from the shared state for recent rounds, else its own cached read. */
async function snapshotFor(mk: PublicKey): Promise<MarketBookSnapshot | null> {
  const state = await liveState();
  const hit = state?.snapshots.find((s) => s.market.address.equals(mk));
  if (hit) return hit;
  return (await bookCache()).get(mk);
}

let tradeStore: TradeStore | undefined;
function tradeIndex(): TradeStore {
  tradeStore ??= new TradeStore(tradeStorePath(exchangeProgramId().toBase58()), tradeDecoder(getRpc()));
  tradeStore.reload();
  return tradeStore;
}

/** Properties never change once registered. */
const properties = new Map<number, PropertyView>();
async function propertyOf(id: number): Promise<PropertyView | null> {
  const hit = properties.get(id);
  if (hit) return hit;
  const p = await getRpc().run((c) => fetchProperty(getExchangeProgram(c), id));
  if (p) properties.set(id, p);
  return p;
}

const key = (v: string | undefined, what: string): PublicKey => {
  try {
    return parsePublicKey(v ?? "", what);
  } catch {
    throw badRequest(`Invalid ${what}`);
  }
};

function roundState(r: RoundView, now: number) {
  return r.status === "closed" ? "closed" : BigInt(Math.floor(now / 1000)) >= r.tradingEndsAt ? "trading_ended" : "open";
}

async function marketSummary(m: MarketView) {
  const property = await propertyOf(m.propertyId);
  return {
    address: m.address,
    round: m.round,
    propertyId: m.propertyId,
    scenarioId: m.scenarioId,
    label: property?.label ?? null,
    latE6: m.latE6,
    lonE6: m.lonE6,
    triggerDistanceM: m.triggerDistanceM,
    vault: m.vault,
    outcome: m.outcome,
    resolutionPath: m.resolutionPath,
    invalidReason: m.invalidReason,
    resolvedAt: m.resolvedAt,
    evidenceHash: m.evidenceHash,
    yesMint: m.yesMint,
    noMint: m.noMint,
    pairsOutstanding: m.pairsOutstanding,
  };
}

/** Markets of a round: from the shared state when recent, else one scan cached for 10 s. */
const olderRounds = new Map<string, { at: number; markets: MarketView[]; settled: boolean }>();
async function marketsOf(round: PublicKey): Promise<MarketView[]> {
  const state = await liveState();
  if (state?.rounds.some((r) => r.address.equals(round))) {
    return state.snapshots.filter((s) => s.market.round.equals(round)).map((s) => s.market);
  }
  const hit = olderRounds.get(round.toBase58());
  // A round whose markets are all resolved never changes again: keep it for good.
  if (hit && (hit.settled || Date.now() - hit.at < 10_000)) return hit.markets;
  // Market addresses are PDAs of (round, property id): read them in one batch and scan only when
  // the known property ids don't explain the round's market count (getProgramAccounts is the
  // scarcest call on hosted RPC tiers).
  const markets = await getRpc().run(async (c) => {
    const p = getExchangeProgram(c);
    const r = await fetchRound(p, round);
    if (r && knownPropertyIds) {
      const keys = knownPropertyIds.map((id) => findMarketPda(p.programId, round, id)[0]);
      const infos = await c.getMultipleAccountsInfo(keys, "confirmed");
      const found = infos.flatMap((info, i) => (info ? [decodeMarketAccount(p, keys[i] as PublicKey, info.data)] : []));
      if (found.length >= r.marketCount) return found;
    }
    knownPropertyIds = await fetchPropertyIds(p);
    return fetchMarketsOfRound(p, round);
  });
  olderRounds.set(round.toBase58(), { at: Date.now(), markets, settled: markets.length > 0 && markets.every((m) => m.outcome !== "unresolved") });
  return markets;
}
let knownPropertyIds: number[] | undefined;

async function roundBody(r: RoundView) {
  const markets = await marketsOf(r.address);
  return { ...r, state: roundState(r, Date.now()), markets: await Promise.all(markets.map(marketSummary)) };
}

/** GET /api/rounds/latest — `Config.latest_round` only (§10.2). */
export const handleLatestRound = (): Promise<Response> =>
  run(async () => {
    const c = await config();
    if (c.latestRound.equals(PublicKey.default)) throw notFound("No round yet");
    const r = await getRpc().run((conn) => fetchRound(getExchangeProgram(conn), c.latestRound));
    if (!r) throw notFound("Round not found");
    return roundBody(r);
  });

/**
 * The current round of a catalog scenario from the shared state cache (refreshed every
 * STATE_TTL_MS, accepted up to 30 s old): the same newest-round rule as the homepage. Reset Market uses it to reject a
 * replaced round in milliseconds instead of reloading 16 rounds from RPC; a briefly stale answer is
 * harmless because openCatalogRound adopts an existing newer round instead of opening another.
 */
export async function cachedCatalogRound(scenarioId: number): Promise<PublicKey | null> {
  const c = catalogByScenario(scenarioId);
  // A resolved copy up to 30 s old is good enough here; only a colder cache waits for a reload.
  const state = stateCache && stateCache.at !== Infinity && Date.now() - stateCache.at < 30_000 ? await stateCache.value : await liveState();
  if (!c || !state) return null;
  const newest = [...state.rounds]
    .filter((r) => r.scenarioId === scenarioId && state.snapshots.some((s) => s.market.round.equals(r.address) && s.market.propertyId === c.propertyId))
    .sort((a, b) => (a.roundId < b.roundId ? 1 : -1))[0];
  return newest?.address ?? null;
}

/**
 * GET /api/featured — the homepage (docs/spec-multiperil.md §7.2): for each catalog market, its
 * newest round among the recent ones and the live YES book top. Prices come from on-chain orders only.
 */
export const handleFeatured = (): Promise<Response> =>
  run(async () => {
    const state = await liveState();
    if (!state) throw unavailable("Exchange is not configured on this cluster");
    const newestFirst = [...state.rounds].sort((a, b) => (a.roundId < b.roundId ? 1 : -1));
    const markets = await Promise.all(
      CATALOG.map(async (c) => {
        for (const r of newestFirst) {
          if (r.scenarioId !== c.scenarioId) continue;
          const snap = state.snapshots.find((s) => s.market.round.equals(r.address) && s.market.propertyId === c.propertyId);
          if (!snap) continue;
          const { yes, no } = marketBooks(snap.book);
          return {
            propertyId: c.propertyId,
            round: { address: r.address, roundId: r.roundId, label: r.label, state: roundState(r, Date.now()), tradingEndsAt: r.tradingEndsAt, closedAt: r.closedAt },
            market: await marketSummary(snap.market),
            yesBestBidBps: yes.bestBidBps,
            yesBestAskBps: yes.bestAskBps,
            yesAskDepth: yes.askDepth,
            noBestAskBps: no.bestAskBps,
          };
        }
        return { propertyId: c.propertyId, round: null, market: null, yesBestBidBps: null, yesBestAskBps: null, yesAskDepth: 0n, noBestAskBps: null };
      }),
    );
    // Listed and homeowner markets (spec-multiperil §7.7) in the round each featured market is shown from.
    const shownRounds = markets.flatMap((m) => (m.round ? [m.round.address] : []));
    const userSnaps = state.snapshots.filter((s) =>
      shownRounds.some((a) => a.equals(s.market.round)) && (isHomeProperty(s.market.propertyId) || LISTINGS.some((l) => l.propertyId === s.market.propertyId)));
    const listed = await Promise.all(
      userSnaps.flatMap((snap) => {
        const r = state.rounds.find((x) => x.address.equals(snap.market.round));
        if (!r) return [];
        return [(async () => {
          const { yes, no } = marketBooks(snap.book);
          return {
            propertyId: snap.market.propertyId,
            round: { address: r.address, roundId: r.roundId, label: r.label, state: roundState(r, Date.now()), tradingEndsAt: r.tradingEndsAt, closedAt: r.closedAt },
            market: await marketSummary(snap.market),
            yesBestBidBps: yes.bestBidBps,
            yesBestAskBps: yes.bestAskBps,
            yesAskDepth: yes.askDepth,
            noBestAskBps: no.bestAskBps,
          };
        })()];
      }),
    );
    return { markets: [...markets, ...listed] };
  });

/**
 * GET /api/listings (docs/spec-multiperil.md §7.7): per hazard, its current catalog round and every
 * listing address with its market in that round, or null when it is not listed yet.
 */
export const handleListings = (): Promise<Response> =>
  run(async () => {
    const state = await liveState();
    if (!state) throw unavailable("Exchange is not configured on this cluster");
    const now = Date.now();
    const hazards = CATALOG.map((c) => {
      const round = [...state.rounds]
        .filter((r) => r.scenarioId === c.scenarioId && state.snapshots.some((s) => s.market.round.equals(r.address) && s.market.propertyId === c.propertyId))
        .sort((a, b) => (a.roundId < b.roundId ? 1 : -1))[0];
      return {
        hazard: c.hazard,
        label: HAZARD_LABEL[c.hazard],
        trigger: c.trigger,
        month: c.month,
        round: round ? { address: round.address, roundId: round.roundId, state: roundState(round, now), tradingEndsAt: round.tradingEndsAt } : null,
        listings: LISTINGS.filter((l) => l.scenarioId === c.scenarioId).map((l) => {
          const snap = round ? state.snapshots.find((s) => s.market.round.equals(round.address) && s.market.propertyId === l.propertyId) : undefined;
          const books = snap ? marketBooks(snap.book) : null;
          return {
            propertyId: l.propertyId,
            address: l.address,
            place: l.place,
            question: l.question,
            market: snap
              ? { address: snap.market.address, outcome: snap.market.outcome, yesBestAskBps: books!.yes.bestAskBps, noBestAskBps: books!.no.bestAskBps }
              : null,
          };
        }),
      };
    });
    return { hazards };
  });

/**
 * GET /api/homes?hazard= (docs/spec-multiperil.md §7.7): the hazard's current catalog round, a
 * suggested opening premium (maker A's starting reference) and every home in its pool with its
 * market in that round, or null.
 */
export const handleHomes = (req: Request): Promise<Response> =>
  run(async () => {
    const hazard = new URL(req.url).searchParams.get("hazard");
    const c = CATALOG.find((x) => x.hazard === hazard);
    if (!c) throw badRequest("hazard must be wildfire, hurricane, earthquake or tornado");
    const state = await liveState();
    if (!state) throw unavailable("Exchange is not configured on this cluster");
    const round = [...state.rounds]
      .filter((r) => r.scenarioId === c.scenarioId && state.snapshots.some((s) => s.market.round.equals(r.address) && s.market.propertyId === c.propertyId))
      .sort((a, b) => (a.roundId < b.roundId ? 1 : -1))[0];
    const listed = new Map(
      round ? state.snapshots.filter((s) => s.market.round.equals(round.address)).map((s) => [s.market.propertyId, s.market.address.toBase58()]) : [],
    );
    return {
      hazard: c.hazard,
      label: HAZARD_LABEL[c.hazard],
      trigger: c.trigger,
      month: c.month,
      suggestedBps: c.ladder[0]?.refBps ?? null,
      round: round ? { address: round.address, roundId: round.roundId, state: roundState(round, Date.now()), tradingEndsAt: round.tradingEndsAt } : null,
      homes: homesOfScenario(c.scenarioId).map((h) => ({ propertyId: h.property_id, address: h.label, place: h.place, market: listed.get(h.property_id) ?? null })),
    };
  });

/** GET /api/rounds/:id — by numeric round id or round address. */
export const handleRound = (id: string | undefined): Promise<Response> =>
  run(async () => {
    const pid = getExchangeProgram(getRpc().connection).programId;
    const addr = /^\d{1,19}$/.test(id ?? "") ? findRoundPda(pid, BigInt(id as string))[0] : key(id, "round");
    const r = await getRpc().run((conn) => fetchRound(getExchangeProgram(conn), addr));
    if (!r) throw notFound("Round not found");
    return roundBody(r);
  });

/** GET /api/markets?round= — defaults to the latest round. */
export const handleMarkets = (req: Request): Promise<Response> =>
  run(async () => {
    const query = new URL(req.url).searchParams;
    if (query.get("all") === "1") {
      const state = await liveState();
      if (!state) throw unavailable("Exchange is not configured on this cluster");
      return { rounds: await Promise.all(state.rounds.map(async (round) => ({
        ...round,
        state: roundState(round, Date.now()),
        markets: await Promise.all(state.snapshots.filter((s) => s.round.address.equals(round.address)).map((s) => marketSummary(s.market))),
      }))) };
    }
    const q = query.get("round");
    const round = q ? key(q, "round") : (await config()).latestRound;
    const markets = await marketsOf(round);
    return { round, markets: await Promise.all(markets.map(marketSummary)) };
  });

const levelBody = (l: OutcomeBook["bids"][number]) => ({
  priceBps: l.priceBps,
  quantity: l.quantity,
  orders: l.orders.map((o) => ({ address: o.id, maker: o.maker, remaining: o.remaining, seq: o.seq })),
});

const bookBody = (b: OutcomeBook) => ({ ...b, bids: b.bids.map(levelBody), asks: b.asks.map(levelBody) });

/** GET /api/markets/:id — state, headline prices (mid or last), volume from finalized fills. */
export const handleMarket = (id: string | undefined): Promise<Response> =>
  run(async () => {
    const mk = key(id, "market address");
    const snap = await snapshotFor(mk);
    if (!snap) throw notFound("Market not found");
    const idx = tradeIndex();
    const fills = idx.trades(mk.toBase58());
    const last = (o: number) => [...fills].reverse().find((t) => t.fill.outcome === o)?.fill.priceBps ?? null;
    const { yes, no } = marketBooks(snap.book);
    return {
      market: await marketSummary(snap.market),
      round: { ...snap.round, state: roundState(snap.round, Date.now()) },
      tradingOpen: snap.tradingOpen,
      headline: { yes: headlinePrice(yes, last(Outcome.Yes)), no: headlinePrice(no, last(Outcome.No)) },
      volume: fills.length || idx.backfilled ? fills.reduce((a, t) => a + t.fill.quoteAmount, 0n) : null,
      indexing: !idx.backfilled,
      confirmingFills: 0,
      bookFetchedAt: new Date(snap.fetchedAt).toISOString(),
      settlementDeadline: snap.round.closedAt > 0n ? snap.round.closedAt + (await config()).resolutionTimeoutS : null,
    };
  });

/** GET /api/markets/:id/book?outcome=yes|no */
export const handleBook = (req: Request, id: string | undefined): Promise<Response> =>
  run(async () => {
    const mk = key(id, "market address");
    const o = new URL(req.url).searchParams.get("outcome") ?? "yes";
    if (o !== "yes" && o !== "no" && o !== "both") throw badRequest("outcome must be yes, no or both");
    const snap = await snapshotFor(mk);
    if (!snap) throw notFound("Market not found");
    const books = marketBooks(snap.book);
    const state = { market: mk, tradingOpen: snap.tradingOpen, fetchedAt: new Date(snap.fetchedAt).toISOString() };
    return o === "both"
      ? { ...state, yes: bookBody(books.yes), no: bookBody(books.no) }
      : { ...state, outcome: o, book: bookBody(o === "yes" ? books.yes : books.no) };
  });

/** GET /api/markets/:id/trades — fills, each finalized or confirming (§7.2). */
export const handleTrades = (id: string | undefined, req?: Request): Promise<Response> =>
  run(async () => {
    const mk = key(id, "market address");
    const idx = tradeIndex();
    const wallet = req && new URL(req.url).searchParams.get("wallet");
    const rows = idx.trades(mk.toBase58()).reverse();
    const trades = wallet ? rows.filter((t) => t.fill.buyer === wallet || t.fill.seller === wallet) : rows.slice(0, 200);
    return { market: mk, indexing: !idx.backfilled, trades };
  });

/** GET /api/markets/:id/chart — "Trades" and "Quoted midpoint" from finalized events (§7.3). */
export const handleChart = (id: string | undefined): Promise<Response> =>
  run(async () => {
    const mk = key(id, "market address");
    const idx = tradeIndex();
    const c = idx.chart(mk.toBase58());
    // An incomplete order-event stream cannot reconstruct historical quote levels.
    const quotes = idx.backfilled ? c.quotes : [];
    return { market: mk, indexing: !idx.backfilled, trades: c.trades, quotes, empty: idx.backfilled && !c.trades.length && !quotes.length };
  });

/**
 * GET /api/orders?maker= — the maker's Order accounts in the recent rounds, including ones the book
 * hides (expired, or in a closed round awaiting sweep), from the shared state. Additive to §7.5:
 * it saves every connected browser a getProgramAccounts scan per poll.
 */
export const handleOrders = (req: Request): Promise<Response> =>
  run(async () => {
    const query = new URL(req.url).searchParams;
    const maker = key(query.get("maker") ?? undefined, "maker");
    const marketParam = query.get("market");
    if (marketParam) {
      const market = key(marketParam, "market");
      return getRpc().run(async (c) => {
        const p = getExchangeProgram(c);
        const m = await fetchExchangeMarket(p, market);
        if (!m) throw notFound("Market not found");
        const r = await fetchRound(p, m.round);
        if (!r) throw notFound("Round not found");
        const orders = await fetchOrders(p, { market, maker });
        return { orders: orders.map((o) => ({ ...o, marketOutcome: m.outcome, tradingOpen: roundState(r, Date.now()) === "open" })) };
      });
    }
    const state = await liveState();
    if (!state) throw unavailable("Exchange is not configured on this cluster");
    const m = maker.toBase58();
    const orders = state.snapshots.flatMap((s) =>
      s.orders.filter((o) => o.maker === m).map((o) => ({ ...o, tradingOpen: s.tradingOpen, marketOutcome: s.market.outcome })),
    );
    return { maker, rounds: state.rounds.map((r) => r.address), orders, now: state.now };
  });

/** Public keys of the MetrEx-operated market makers, for the "MetrEx market maker A/B/C" labels (§8.4). */
let makersCache: { name: string; address: string }[] | undefined;
function marketMakers(): { name: string; address: string }[] {
  if (!makersCache) {
    const out: { name: string; address: string }[] = [];
    for (const [name, k] of [["A", "botA"], ["B", "botB"], ["C", "botC"]] as [string, KeypairName][]) {
      try {
        out.push({ name, address: loadKeypair(k).publicKey.toBase58() });
      } catch {
        /* key not on this host: no label */
      }
    }
    makersCache = out;
  }
  return makersCache;
}

/**
 * Public records of the simulated traders (docs/spec-simulation.md §2), for the "Simulated trader"
 * labels. Wallets and archetypes only; written by scripts/provision-sim.ts. Re-read every minute.
 */
let simCache: { at: number; rows: { address: string; id: string; archetype: string }[] } | undefined;
function simulatedTraders(): { address: string; id: string; archetype: string }[] {
  if (!simCache || Date.now() - simCache.at > 60_000) {
    let rows: { address: string; id: string; archetype: string }[] = [];
    try {
      const raw = JSON.parse(readFileSync(join(keyDir(), "sim", "population.json"), "utf8")) as Array<Record<string, unknown>>;
      rows = raw.map((r) => ({ address: String(r.address), id: String(r.id), archetype: String(r.archetype) }));
    } catch {
      /* no simulation on this host */
    }
    simCache = { at: Date.now(), rows };
  }
  return simCache.rows;
}

const pk = (v: unknown): string => (v as PublicKey).toBase58();
const big = (v: unknown): bigint => BigInt((v as BN).toString());

/**
 * GET /api/markets/:id/ledger — trade and settlement ledger rebuilt from the market's finalized
 * program events and its vault balance (docs/spec-simulation.md §8). Never from the simulator.
 */
export const handleLedger = (id: string | undefined): Promise<Response> =>
  run(async () => {
    const mk = key(id, "market address");
    const rpc = getRpc();
    const market = await rpc.run((c) => fetchExchangeMarket(getExchangeProgram(c), mk, "finalized"));
    if (!market) throw notFound("Market not found");
    const idx = tradeIndex();
    if (!idx.backfilled) return { market: mk, indexing: true };
    const events: LedgerEvent[] = [];
    for (const e of idx.events(mk.toBase58())) {
      const at = { signature: e.pos.signature, blockTime: e.pos.blockTime };
      if (e.name === "OrderFilled") {
        events.push({ ...at, kind: "fill", outcome: e.outcome, buyer: e.buyer, seller: e.seller, quantity: e.quantity, priceBps: e.priceBps, quoteAmount: e.quoteAmount });
      } else if (e.name === "SharesSplit" || e.name === "SharesMerged") {
        events.push({ ...at, kind: e.name === "SharesSplit" ? "split" : "merge", holder: pk(e.data.holder), quantity: big(e.data.quantity), amount: big(e.data.amount) });
      } else if (e.name === "SharesRedeemed") {
        events.push({ ...at, kind: "redeem", holder: pk(e.data.holder), outcome: Number(e.data.outcome), quantity: big(e.data.quantity), payout: big(e.data.payout) });
      }
    }
    const vaultBalance = await rpc.run((c) => tokenBalance(c, market.vault, "finalized"));
    const ledger = buildLedger(events, { outcome: market.outcome, pairsOutstanding: market.pairsOutstanding, vaultBalance });
    return {
      market: mk,
      indexing: false,
      propertyId: market.propertyId,
      vault: market.vault,
      resolvedAt: market.resolvedAt,
      makers: marketMakers(),
      simulatedTraders: simulatedTraders(),
      ...ledger,
    };
  });

/** GET /api/health — keeper and bot heartbeats, RPC. */
export const handleHealth = (): Promise<Response> =>
  run(async () => {
    let rpc: { ok: boolean; slot: number | null } = { ok: false, slot: null };
    try {
      rpc = { ok: true, slot: await getRpc().run((c) => c.getSlot("confirmed")) };
    } catch {
      /* reported as not ok */
    }
    const keeper = readHeartbeat("keeper");
    return { rpc, keeper, bots: readHeartbeat("bots"), sim: readHeartbeat("sim"), matching: keeper.alive && keeper.heartbeat?.status.matching === true ? "running" : "paused", marketMakers: marketMakers(), simulatedTraders: simulatedTraders() };
  });

/** Lookup helper for scripts and the operator page. */
export async function readMarket(market: PublicKey): Promise<MarketView | null> {
  return getRpc().run((c) => fetchExchangeMarket(getExchangeProgram(c), market));
}
