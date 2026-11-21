// §7.5 read API for the v2 exchange, framework-agnostic (standard Request/Response). Reads the chain
// directly with a short in-memory cache and never depends on the keeper process. When the chain
// can't be read, the response says "unavailable"; cached data is never presented as live.

import { PublicKey } from "@solana/web3.js";
import { findMarketPda, findRoundPda, headlinePrice, marketBooks, Outcome, type OutcomeBook } from "@metrex/exchange";
import { loadKeypair, parsePublicKey, type KeypairName } from "../env";
import { getRpc } from "../rpc";
import {
  decodeMarketAccount,
  fetchPropertyIds,
  fetchExchangeConfig,
  fetchExchangeMarket,
  fetchMarketsOfRound,
  fetchProperty,
  fetchRound,
  type ConfigView,
  type MarketView,
  type PropertyView,
  type RoundView,
} from "../exchange/accounts";
import { BookCache, ExchangeStateLoader, type ExchangeState, type MarketBookSnapshot } from "../exchange/book";
import { readHeartbeat } from "../exchange/heartbeat";
import { getExchangeProgram } from "../exchange/program";
import { connectionTradeSource, TradeIndex } from "../exchange/trades";
import { badRequest, HttpError, notFound, unavailable } from "./errors";

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
    const value = getRpc().run((c) => loader.load(c, { roundsBack: 3 }));
    stateCache = { at: Date.now(), value };
    value.catch(() => {
      if (stateCache?.value === value) stateCache = undefined;
    });
  }
  return stateCache.value;
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

const tradeIndexes = new Map<string, TradeIndex>();
const backfilling = new Map<string, Promise<void>>();
/**
 * One trade index per market (signatures for the market's address, a few hundred at most),
 * refreshed at most every 2 s. Until its initial backfill is fully decoded it is returned as
 * `null` after a short wait instead of holding the request: callers then report "indexing", never
 * a made-up volume or an empty history presented as complete. The backfill keeps going in the
 * background without waiting for the next request.
 */
async function tradeIndex(mk: PublicKey, waitMs = 1_500): Promise<TradeIndex | null> {
  const key = mk.toBase58();
  let idx = tradeIndexes.get(key);
  if (!idx) {
    idx = new TradeIndex(connectionTradeSource(() => getRpc().connection, mk), { pageSize: 200, maxBackfill: 2_000, txPerRefresh: 25 });
    tradeIndexes.set(key, idx);
  }
  const index = idx;
  if (index.lastRefresh === undefined || Date.now() - index.lastRefresh > 2_000) {
    const backfill = async () => {
      do {
        try {
          await index.refresh();
        } catch (e: unknown) {
          console.error(`[api] trade index ${key.slice(0, 8)} refresh failed:`, e instanceof Error ? e.message : String(e));
          await new Promise((r) => setTimeout(r, 2_000));
        }
      } while (!index.backfilled);
    };
    let refreshing: Promise<void>;
    if (index.backfilled) refreshing = index.refresh().catch(() => undefined);
    else {
      refreshing = backfilling.get(key) ?? backfill().finally(() => backfilling.delete(key));
      backfilling.set(key, refreshing);
    }
    if (!index.backfilled) await Promise.race([refreshing, new Promise((r) => setTimeout(r, waitMs))]);
  }
  return index.backfilled ? index : null;
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
    const q = new URL(req.url).searchParams.get("round");
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
    const idx = await tradeIndex(mk);
    const fills = idx ? idx.trades(mk.toBase58()) : [];
    const finalized = fills.filter((t) => t.finalized);
    const last = (o: number) => [...finalized].reverse().find((t) => t.fill.outcome === o)?.fill.priceBps ?? null;
    const { yes, no } = marketBooks(snap.book);
    return {
      market: await marketSummary(snap.market),
      round: { ...snap.round, state: roundState(snap.round, Date.now()) },
      tradingOpen: snap.tradingOpen,
      headline: { yes: headlinePrice(yes, last(Outcome.Yes)), no: headlinePrice(no, last(Outcome.No)) },
      volume: idx ? finalized.reduce((a, t) => a + t.fill.quoteAmount, 0n) : null,
      indexing: !idx,
      confirmingFills: fills.length - finalized.length,
      bookFetchedAt: new Date(snap.fetchedAt).toISOString(),
    };
  });

/** GET /api/markets/:id/book?outcome=yes|no */
export const handleBook = (req: Request, id: string | undefined): Promise<Response> =>
  run(async () => {
    const mk = key(id, "market address");
    const o = new URL(req.url).searchParams.get("outcome") ?? "yes";
    if (o !== "yes" && o !== "no") throw badRequest("outcome must be yes or no");
    const snap = await snapshotFor(mk);
    if (!snap) throw notFound("Market not found");
    const books = marketBooks(snap.book);
    return { market: mk, outcome: o, tradingOpen: snap.tradingOpen, fetchedAt: new Date(snap.fetchedAt).toISOString(), book: bookBody(o === "yes" ? books.yes : books.no) };
  });

/** GET /api/markets/:id/trades — fills, each finalized or confirming (§7.2). */
export const handleTrades = (id: string | undefined): Promise<Response> =>
  run(async () => {
    const mk = key(id, "market address");
    const idx = await tradeIndex(mk);
    return { market: mk, indexing: !idx, trades: idx ? idx.trades(mk.toBase58()).reverse().slice(0, 200) : [] };
  });

/** GET /api/markets/:id/chart — "Trades" and "Quoted midpoint" from finalized events (§7.3). */
export const handleChart = (id: string | undefined): Promise<Response> =>
  run(async () => {
    const mk = key(id, "market address");
    const idx = await tradeIndex(mk);
    if (!idx) return { market: mk, indexing: true, trades: [], quotes: [], empty: false };
    const c = idx.chart(mk.toBase58());
    return { market: mk, indexing: false, trades: c.trades, quotes: c.quotes, empty: c.trades.length === 0 && c.quotes.length === 0 };
  });

/**
 * GET /api/orders?maker= — the maker's Order accounts in the recent rounds, including ones the book
 * hides (expired, or in a closed round awaiting sweep), from the shared state. Additive to §7.5:
 * it saves every connected browser a getProgramAccounts scan per poll.
 */
export const handleOrders = (req: Request): Promise<Response> =>
  run(async () => {
    const maker = key(new URL(req.url).searchParams.get("maker") ?? undefined, "maker");
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
    return { rpc, keeper, bots: readHeartbeat("bots"), matching: keeper.alive ? "running" : "paused", marketMakers: marketMakers() };
  });

/** Lookup helper for scripts and the operator page. */
export async function readMarket(market: PublicKey): Promise<MarketView | null> {
  return getRpc().run((c) => fetchExchangeMarket(getExchangeProgram(c), market));
}
