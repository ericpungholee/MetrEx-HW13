// §7.5 read API for the v2 exchange, framework-agnostic (standard Request/Response). Reads the chain
// directly with a short in-memory cache and never depends on the keeper process. When the chain
// can't be read, the response says "unavailable"; cached data is never presented as live.

import { PublicKey } from "@solana/web3.js";
import { findRoundPda, headlinePrice, marketBooks, Outcome, type OutcomeBook } from "@metrex/exchange";
import { parsePublicKey } from "../env";
import { getRpc } from "../rpc";
import {
  fetchExchangeConfig,
  fetchExchangeMarket,
  fetchMarketsOfRound,
  fetchProperty,
  fetchRound,
  type ConfigView,
  type MarketView,
  type RoundView,
} from "../exchange/accounts";
import { BookCache } from "../exchange/book";
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

let books: BookCache | undefined;
async function bookCache(): Promise<BookCache> {
  const c = await config();
  books ??= new BookCache(() => getRpc().connection, c.collateralMint);
  return books;
}

let trades: TradeIndex | undefined;
async function tradeIndex(): Promise<TradeIndex> {
  if (!trades) {
    const pid = getExchangeProgram(getRpc().connection).programId;
    trades = new TradeIndex(connectionTradeSource(() => getRpc().connection, pid));
  }
  if (trades.lastRefresh === undefined || Date.now() - trades.lastRefresh > 2_000) {
    await trades.refresh().catch((e: unknown) => {
      if (trades?.lastRefresh === undefined) throw e;
    });
  }
  return trades;
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
  const property = await getRpc().run((c) => fetchProperty(getExchangeProgram(c), m.propertyId));
  return { address: m.address, round: m.round, propertyId: m.propertyId, label: property?.label ?? null, outcome: m.outcome, resolutionPath: m.resolutionPath, yesMint: m.yesMint, noMint: m.noMint, pairsOutstanding: m.pairsOutstanding };
}

async function roundBody(r: RoundView) {
  const markets = await getRpc().run((c) => fetchMarketsOfRound(getExchangeProgram(c), r.address));
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
    const markets = await getRpc().run((c) => fetchMarketsOfRound(getExchangeProgram(c), round));
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
    const snap = await (await bookCache()).get(mk);
    if (!snap) throw notFound("Market not found");
    const idx = await tradeIndex();
    const fills = idx.trades(mk.toBase58());
    const finalized = fills.filter((t) => t.finalized);
    const last = (o: number) => [...finalized].reverse().find((t) => t.fill.outcome === o)?.fill.priceBps ?? null;
    const { yes, no } = marketBooks(snap.book);
    return {
      market: await marketSummary(snap.market),
      round: { ...snap.round, state: roundState(snap.round, Date.now()) },
      tradingOpen: snap.tradingOpen,
      headline: { yes: headlinePrice(yes, last(Outcome.Yes)), no: headlinePrice(no, last(Outcome.No)) },
      volume: finalized.reduce((a, t) => a + t.fill.quoteAmount, 0n),
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
    const snap = await (await bookCache()).get(mk);
    if (!snap) throw notFound("Market not found");
    const books = marketBooks(snap.book);
    return { market: mk, outcome: o, tradingOpen: snap.tradingOpen, fetchedAt: new Date(snap.fetchedAt).toISOString(), book: bookBody(o === "yes" ? books.yes : books.no) };
  });

/** GET /api/markets/:id/trades — fills, each finalized or confirming (§7.2). */
export const handleTrades = (id: string | undefined): Promise<Response> =>
  run(async () => {
    const mk = key(id, "market address");
    const idx = await tradeIndex();
    return { market: mk, trades: idx.trades(mk.toBase58()).reverse().slice(0, 200) };
  });

/** GET /api/markets/:id/chart — "Trades" and "Quoted midpoint" from finalized events (§7.3). */
export const handleChart = (id: string | undefined): Promise<Response> =>
  run(async () => {
    const mk = key(id, "market address");
    const c = (await tradeIndex()).chart(mk.toBase58());
    return { market: mk, trades: c.trades, quotes: c.quotes, empty: c.trades.length === 0 && c.quotes.length === 0 };
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
    return { rpc, keeper, bots: readHeartbeat("bots"), matching: keeper.alive ? "running" : "paused" };
  });

/** Lookup helper for scripts and the operator page. */
export async function readMarket(market: PublicKey): Promise<MarketView | null> {
  return getRpc().run((c) => fetchExchangeMarket(getExchangeProgram(c), market));
}
