// v2 exchange client (spec-v2 §10). Every chain access of the v2 pages goes through this module:
// reads come from the §7.5 API (one cached server-side state) and the wallet's own accounts through
// /api/rpc; writes are planned with the pure planners in @metrex/exchange, built with the shared
// instruction builders, simulated before the wallet opens, and confirmed by polling.
//
// Nothing here invents a price, level, fill or chart point. Fixture data exists only behind
// NEXT_PUBLIC_USE_FIXTURES=1 (production builds refuse it) and every write refuses in that mode.

import { Program } from "@anchor-lang/core";
import { createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  describeExchangeError,
  findConfigPda,
  INVALID_PAYOUT_PER_SHARE,
  MAX_MATCH_LEVELS,
  MAX_PRICE_BPS,
  MIN_PRICE_BPS,
  OrderSide,
  Outcome,
  PAYOUT_PER_SHARE,
  planLimitOrder,
  planMarketOrder,
  quote,
  randomNonce,
  type BookOrder,
  type Fill,
  type MarketOutcomeName,
  type OrderSideCode,
  type OutcomeCode,
} from "@metrex/exchange";
import {
  ataOf,
  cancelOrderIx,
  matchOrdersIx,
  placeOrderIx,
  redeemIx,
  sweepOrderIx,
  takeOrderIx,
} from "@metrex/server/exchange/browser";
import idlJson from "../../target/idl/metrex_exchange.json";
import type { MetrexExchange } from "../../target/types/metrex_exchange";
import { measureTransactionSize, MAX_TX_BYTES } from "./batch";
import { FixtureModeError, type TxResult, type WalletSigner, type WriteOptions } from "./client";
import { USE_FIXTURES } from "./env";
import { fixtureApi } from "./exchange-fixtures";
import { explorerTx } from "./format";

export { FixtureModeError, USE_FIXTURES };

// ---------------------------------------------------------------------------
// Types (API JSON → bigint / PublicKey-free plain values)
// ---------------------------------------------------------------------------

export type RoundState = "open" | "trading_ended" | "closed";

export interface MarketSummary {
  address: string;
  round: string;
  propertyId: number;
  label: string | null;
  latE6: number;
  lonE6: number;
  triggerDistanceM: number;
  vault: string;
  outcome: MarketOutcomeName;
  resolutionPath: number;
  invalidReason: number;
  resolvedAt: bigint;
  evidenceHash: string;
  yesMint: string;
  noMint: string;
  pairsOutstanding: bigint;
}

export interface RoundInfo {
  address: string;
  roundId: bigint;
  scenarioId: number;
  label: string;
  status: "open" | "closed";
  state: RoundState;
  createdAt: bigint;
  tradingEndsAt: bigint;
  closedAt: bigint;
  marketCount: number;
  resolvedCount: number;
  datasetSha256: string;
}

export interface RoundWithMarkets extends RoundInfo {
  markets: MarketSummary[];
}

export type Headline = { source: "mid" | "last"; priceBps: number } | { source: "none"; priceBps: null };

export interface MarketInfo {
  market: MarketSummary;
  round: RoundInfo;
  tradingOpen: boolean;
  headline: { yes: Headline; no: Headline };
  /** Finalized volume; null while the trade index is still backfilling (never shown as 0). */
  volume: bigint | null;
  confirmingFills: number;
  bookFetchedAt: string;
}

export interface LevelInfo {
  priceBps: number;
  quantity: bigint;
  orders: { address: string; maker: string; remaining: bigint; seq: bigint }[];
}

export interface BookSide {
  outcome: OutcomeCode;
  bids: LevelInfo[];
  asks: LevelInfo[];
  bestBidBps: number | null;
  bestAskBps: number | null;
  spreadBps: number | null;
  bidDepth: bigint;
  askDepth: bigint;
}

export interface BookInfo {
  market: string;
  tradingOpen: boolean;
  fetchedAt: string;
  yes: BookSide;
  no: BookSide;
}

export interface TradeInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  finalized: boolean;
  outcome: OutcomeCode;
  buyer: string;
  seller: string;
  quantity: bigint;
  priceBps: number;
  quoteAmount: bigint;
}

export interface ChartPointTrade {
  signature: string;
  blockTime: number | null;
  slot: number;
  outcome: OutcomeCode;
  priceBps: number;
  quantity: bigint;
}

export interface ChartPointQuote {
  signature: string;
  blockTime: number | null;
  slot: number;
  outcome: OutcomeCode;
  bestBidBps: number | null;
  bestAskBps: number | null;
  midBps: number | null;
}

export interface ChartInfo {
  trades: ChartPointTrade[];
  quotes: ChartPointQuote[];
  empty: boolean;
  /** The trade index is still backfilling; the chart is incomplete, not empty. */
  indexing: boolean;
}

export interface HealthInfo {
  rpc: { ok: boolean; slot: number | null };
  keeperAlive: boolean;
  botsAlive: boolean;
  matching: "running" | "paused";
  /** address → "A" | "B" | "C" */
  marketMakers: Map<string, string>;
}

export interface WalletOrder {
  address: string;
  market: string;
  maker: string;
  clientNonce: bigint;
  outcome: OutcomeCode;
  side: OrderSideCode;
  priceBps: number;
  originalQty: bigint;
  remainingQty: bigint;
  seq: bigint;
  expiresAt: bigint;
  createdAt: bigint;
  tradingOpen: boolean;
  marketOutcome: MarketOutcomeName;
}

export interface Holdings {
  musd: bigint;
  sol: bigint;
  /** market address → shares */
  yes: Map<string, bigint>;
  no: Map<string, bigint>;
}

// ---------------------------------------------------------------------------
// JSON parsing (the API sends bigint as decimal strings)
// ---------------------------------------------------------------------------

type J = Record<string, unknown>;
const big = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(String(v ?? 0)));
const num = (v: unknown): number => Number(v ?? 0);
const str = (v: unknown): string => String(v ?? "");

function parseMarketSummary(m: J): MarketSummary {
  return {
    address: str(m.address),
    round: str(m.round),
    propertyId: num(m.propertyId),
    label: m.label === null || m.label === undefined ? null : str(m.label),
    latE6: num(m.latE6),
    lonE6: num(m.lonE6),
    triggerDistanceM: num(m.triggerDistanceM),
    vault: str(m.vault),
    outcome: str(m.outcome) as MarketOutcomeName,
    resolutionPath: num(m.resolutionPath),
    invalidReason: num(m.invalidReason),
    resolvedAt: big(m.resolvedAt),
    evidenceHash: str(m.evidenceHash),
    yesMint: str(m.yesMint),
    noMint: str(m.noMint),
    pairsOutstanding: big(m.pairsOutstanding),
  };
}

function parseRound(r: J): RoundInfo {
  return {
    address: str(r.address),
    roundId: big(r.roundId),
    scenarioId: num(r.scenarioId),
    label: str(r.label),
    status: str(r.status) === "open" ? "open" : "closed",
    state: str(r.state) as RoundState,
    createdAt: big(r.createdAt),
    tradingEndsAt: big(r.tradingEndsAt),
    closedAt: big(r.closedAt),
    marketCount: num(r.marketCount),
    resolvedCount: num(r.resolvedCount),
    datasetSha256: str(r.datasetSha256),
  };
}

const parseRoundWithMarkets = (r: J): RoundWithMarkets => ({ ...parseRound(r), markets: ((r.markets as J[]) ?? []).map(parseMarketSummary) });

const parseHeadline = (h: J): Headline =>
  h.source === "mid" || h.source === "last" ? { source: h.source, priceBps: num(h.priceBps) } : { source: "none", priceBps: null };

function parseLevel(l: J): LevelInfo {
  return {
    priceBps: num(l.priceBps),
    quantity: big(l.quantity),
    orders: ((l.orders as J[]) ?? []).map((o) => ({ address: str(o.address), maker: str(o.maker), remaining: big(o.remaining), seq: big(o.seq) })),
  };
}

function parseBookSide(b: J, outcome: OutcomeCode): BookSide {
  const n = (v: unknown) => (v === null || v === undefined ? null : num(v));
  return {
    outcome,
    bids: ((b.bids as J[]) ?? []).map(parseLevel),
    asks: ((b.asks as J[]) ?? []).map(parseLevel),
    bestBidBps: n(b.bestBidBps),
    bestAskBps: n(b.bestAskBps),
    spreadBps: n(b.spreadBps),
    bidDepth: big(b.bidDepth),
    askDepth: big(b.askDepth),
  };
}

// ---------------------------------------------------------------------------
// API reads
// ---------------------------------------------------------------------------

/** "unavailable" is shown as such; cached data is never presented as live (§7.5). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function getJson(path: string): Promise<J> {
  if (USE_FIXTURES) {
    try {
      return fixtureApi(path);
    } catch (e) {
      throw new ApiError(404, (e as Error).message);
    }
  }
  const res = await fetch(path, { cache: "no-store" });
  let body: J = {};
  try {
    body = (await res.json()) as J;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new ApiError(res.status, typeof body.error === "string" ? body.error : `Exchange data unavailable (HTTP ${res.status})`);
  return body;
}

export async function fetchLatestRound(): Promise<RoundWithMarkets | null> {
  try {
    return parseRoundWithMarkets(await getJson("/api/rounds/latest"));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function fetchRound(id: string | bigint): Promise<RoundWithMarkets | null> {
  try {
    return parseRoundWithMarkets(await getJson(`/api/rounds/${id.toString()}`));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

export async function fetchMarketInfo(market: string): Promise<MarketInfo | null> {
  let j: J;
  try {
    j = await getJson(`/api/markets/${market}`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
  const h = (j.headline as J) ?? {};
  return {
    market: parseMarketSummary(j.market as J),
    round: parseRound(j.round as J),
    tradingOpen: j.tradingOpen === true,
    headline: { yes: parseHeadline((h.yes as J) ?? {}), no: parseHeadline((h.no as J) ?? {}) },
    volume: j.volume === null || j.volume === undefined ? null : big(j.volume),
    confirmingFills: num(j.confirmingFills),
    bookFetchedAt: str(j.bookFetchedAt),
  };
}

export async function fetchBook(market: string): Promise<BookInfo> {
  const [y, n] = await Promise.all([getJson(`/api/markets/${market}/book?outcome=yes`), getJson(`/api/markets/${market}/book?outcome=no`)]);
  return {
    market,
    tradingOpen: y.tradingOpen === true,
    fetchedAt: str(y.fetchedAt),
    yes: parseBookSide(y.book as J, Outcome.Yes),
    no: parseBookSide(n.book as J, Outcome.No),
  };
}

/** Trade history is still being backfilled from chain events; retry shortly. */
export class TradeIndexingError extends Error {
  constructor() {
    super("Trade history is still being indexed from chain events.");
  }
}

export async function fetchTrades(market: string): Promise<TradeInfo[]> {
  const j = await getJson(`/api/markets/${market}/trades`);
  if (j.indexing === true) throw new TradeIndexingError();
  return ((j.trades as J[]) ?? []).map((t) => {
    const f = (t.fill as J) ?? {};
    return {
      signature: str(t.signature),
      slot: num(t.slot),
      blockTime: t.blockTime === null || t.blockTime === undefined ? null : num(t.blockTime),
      finalized: t.finalized === true,
      outcome: num(f.outcome) as OutcomeCode,
      buyer: str(f.buyer),
      seller: str(f.seller),
      quantity: big(f.quantity),
      priceBps: num(f.priceBps),
      quoteAmount: big(f.quoteAmount),
    };
  });
}

export async function fetchChart(market: string): Promise<ChartInfo> {
  const j = await getJson(`/api/markets/${market}/chart`);
  const bt = (v: unknown) => (v === null || v === undefined ? null : num(v));
  const nb = (v: unknown) => (v === null || v === undefined ? null : num(v));
  return {
    trades: ((j.trades as J[]) ?? []).map((t) => ({
      signature: str(t.signature),
      blockTime: bt(t.blockTime),
      slot: num(t.slot),
      outcome: num(t.outcome) as OutcomeCode,
      priceBps: num(t.priceBps),
      quantity: big(t.quantity),
    })),
    quotes: ((j.quotes as J[]) ?? []).map((q) => ({
      signature: str(q.signature),
      blockTime: bt(q.blockTime),
      slot: num(q.slot),
      outcome: num(q.outcome) as OutcomeCode,
      bestBidBps: nb(q.bestBidBps),
      bestAskBps: nb(q.bestAskBps),
      midBps: nb(q.midBps),
    })),
    empty: j.empty === true,
    indexing: j.indexing === true,
  };
}

export async function fetchHealth(): Promise<HealthInfo> {
  const j = await getJson("/api/health");
  const rpc = (j.rpc as J) ?? {};
  return {
    rpc: { ok: rpc.ok === true, slot: rpc.slot === null || rpc.slot === undefined ? null : num(rpc.slot) },
    keeperAlive: ((j.keeper as J) ?? {}).alive === true,
    botsAlive: ((j.bots as J) ?? {}).alive === true,
    matching: j.matching === "running" ? "running" : "paused",
    marketMakers: new Map(((j.marketMakers as J[]) ?? []).map((m) => [str(m.address), str(m.name)])),
  };
}

export async function fetchWalletOrders(owner: PublicKey): Promise<WalletOrder[]> {
  const j = await getJson(`/api/orders?maker=${owner.toBase58()}`);
  return ((j.orders as J[]) ?? []).map((o) => ({
    address: str(o.address),
    market: str(o.market),
    maker: str(o.maker),
    clientNonce: big(o.clientNonce),
    outcome: num(o.outcome) as OutcomeCode,
    side: num(o.side) as OrderSideCode,
    priceBps: num(o.priceBps),
    originalQty: big(o.originalQty),
    remainingQty: big(o.remainingQty),
    seq: big(o.seq),
    expiresAt: big(o.expiresAt),
    createdAt: big(o.createdAt),
    tradingOpen: o.tradingOpen === true,
    marketOutcome: str(o.marketOutcome) as MarketOutcomeName,
  }));
}

/** Evidence text exactly as published (only after finalized settlement with a matching hash). */
export async function fetchEvidenceRaw(market: string, signal?: AbortSignal): Promise<string | null> {
  if (USE_FIXTURES) return null;
  const res = await fetch(`/api/evidence/${market}?raw=1`, { cache: "no-store", signal });
  return res.ok ? res.text() : null;
}

/** SHA-256 hex of a UTF-8 string, computed in the browser. */
export async function sha256HexOf(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Chain access for the wallet (through /api/rpc)
// ---------------------------------------------------------------------------

let connection: Connection | undefined;
let program: Program<MetrexExchange> | undefined;

/** The browser's connection: the app's own RPC route (keys stay on the server). */
export function exchangeConnection(): Connection {
  if (!connection) {
    const origin = typeof window === "undefined" ? "http://127.0.0.1" : window.location.origin;
    connection = new Connection(`${origin}/api/rpc`, { commitment: "confirmed" });
  }
  return connection;
}

export function exchangeProgram(): Program<MetrexExchange> {
  program ??= new Program<MetrexExchange>(idlJson as unknown as MetrexExchange, { connection: exchangeConnection() });
  return program;
}

export const EXCHANGE_PROGRAM_ID = new PublicKey((idlJson as { address: string }).address);

let collateralCache: PublicKey | undefined;
/** mUSD mint from the on-chain Config (never from configuration). */
export async function collateralMint(): Promise<PublicKey> {
  if (collateralCache) return collateralCache;
  if (USE_FIXTURES) return new PublicKey(new Uint8Array(32).fill(9));
  const cfg = await exchangeProgram().account.config.fetch(findConfigPda(EXCHANGE_PROGRAM_ID)[0]);
  collateralCache = cfg.collateralMint;
  return collateralCache;
}

const tokenAmount = (data: Uint8Array | undefined | null): bigint => {
  if (!data || data.length < 72) return 0n;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
};

/** mUSD, SOL and YES/NO holdings for the given markets, in one or two batched reads. */
export async function fetchHoldings(owner: PublicKey, markets: readonly Pick<MarketSummary, "address" | "yesMint" | "noMint">[]): Promise<Holdings> {
  if (USE_FIXTURES) return { musd: 0n, sol: 0n, yes: new Map(), no: new Map() };
  const conn = exchangeConnection();
  const usd = await collateralMint();
  const keys = [owner, ataOf(usd, owner), ...markets.flatMap((m) => [ataOf(new PublicKey(m.yesMint), owner), ataOf(new PublicKey(m.noMint), owner)])];
  const infos: (Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>>[number])[] = [];
  for (let i = 0; i < keys.length; i += 100) infos.push(...(await conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed")));
  const yes = new Map<string, bigint>();
  const no = new Map<string, bigint>();
  markets.forEach((m, i) => {
    yes.set(m.address, tokenAmount(infos[2 + 2 * i]?.data));
    no.set(m.address, tokenAmount(infos[3 + 2 * i]?.data));
  });
  return { musd: tokenAmount(infos[1]?.data), sol: BigInt(infos[0]?.lamports ?? 0), yes, no };
}

// ---------------------------------------------------------------------------
// Pure helpers: book → planner input, previews, reserved balances
// ---------------------------------------------------------------------------

/** Both books as planner rows (only orders the book shows). */
export function bookOrders(b: BookInfo): BookOrder[] {
  const rows: BookOrder[] = [];
  for (const side of [b.yes, b.no]) {
    for (const [levels, s] of [
      [side.bids, OrderSide.Buy],
      [side.asks, OrderSide.Sell],
    ] as const) {
      for (const l of levels) {
        for (const o of l.orders) rows.push({ id: o.address, maker: o.maker, outcome: side.outcome, side: s, priceBps: l.priceBps, remaining: o.remaining, seq: o.seq });
      }
    }
  }
  return rows;
}

export interface TradeIntent {
  outcome: OutcomeCode;
  side: OrderSideCode;
  kind: "market" | "limit";
  quantity: bigint;
  /** Limit price, or for a market order the slippage in bps from the best price. */
  priceBps?: number;
  slippageBps?: number;
}

export interface TradePreview {
  intent: TradeIntent;
  fills: Fill[];
  /** Filled now / quote for the fills. */
  filledQty: bigint;
  filledQuote: bigint;
  /** Average fill price in mUSD base units per share (truncated), or null without fills. */
  avgPerShare: bigint | null;
  /** Market order: shares that cannot fill within the worst price (not sent). Limit: shares that rest. */
  restQty: bigint;
  /** The limit sent on-chain (market: the worst acceptable price). */
  limitPriceBps: number;
  /** Escrowed at placement (limit only): mUSD base units for a BUY, shares for a SELL. */
  escrow: { musd: bigint; shares: bigint };
  /** Fills dropped to keep the transaction within size; they rest and the keeper matches them. */
  droppedFills: number;
  problems: string[];
}

export const clampPrice = (bps: number): number => Math.max(MIN_PRICE_BPS, Math.min(MAX_PRICE_BPS, Math.round(bps)));

/** Preview of an order against the current book (§10.3). Pure. */
export function previewTrade(book: readonly BookOrder[], intent: TradeIntent, me: string, have: { musd: bigint; shares: bigint }): TradePreview {
  const problems: string[] = [];
  const { outcome, side, quantity } = intent;
  let fills: Fill[] = [];
  let restQty = 0n;
  let limitPriceBps: number;
  if (intent.kind === "market") {
    const opposite = book
      .filter((o) => o.outcome === outcome && o.side !== side && o.maker !== me)
      .sort((a, b) => (side === OrderSide.Buy ? a.priceBps - b.priceBps : b.priceBps - a.priceBps))[0];
    const slip = intent.slippageBps ?? 200;
    limitPriceBps = opposite ? clampPrice(side === OrderSide.Buy ? opposite.priceBps + slip : opposite.priceBps - slip) : side === OrderSide.Buy ? MAX_PRICE_BPS : MIN_PRICE_BPS;
    if (!opposite) problems.push(`No ${side === OrderSide.Buy ? "asks" : "bids"} on this book.`);
    const r = planMarketOrder(book, { outcome, side, qty: quantity, worstPriceBps: limitPriceBps, taker: me });
    fills = r.fills;
    restQty = r.unfilled;
  } else {
    limitPriceBps = intent.priceBps ?? 0;
    if (!Number.isInteger(limitPriceBps) || limitPriceBps < MIN_PRICE_BPS || limitPriceBps > MAX_PRICE_BPS) problems.push("Price must be between 0.0001 and 0.9999 mUSD.");
    const r = planLimitOrder(book, { outcome, side, qty: quantity, priceBps: clampPrice(limitPriceBps), maker: me });
    fills = r.fills;
    restQty = r.rests;
  }
  if (quantity <= 0n) problems.push("Enter a quantity of at least 1 share.");
  const filledQty = fills.reduce((a, f) => a + f.qty, 0n);
  const filledQuote = fills.reduce((a, f) => a + f.quote, 0n);
  const escrow =
    intent.kind === "limit"
      ? side === OrderSide.Buy
        ? { musd: quote(quantity > 0n ? quantity : 0n, clampPrice(limitPriceBps)), shares: 0n }
        : { musd: 0n, shares: quantity }
      : { musd: 0n, shares: 0n };
  if (side === OrderSide.Buy) {
    const need = intent.kind === "limit" ? escrow.musd : filledQuote;
    if (need > have.musd) problems.push("Not enough mUSD in your wallet.");
  } else {
    const need = intent.kind === "limit" ? quantity : filledQty;
    if (need > have.shares) problems.push(`You hold ${have.shares} ${outcome === Outcome.Yes ? "YES" : "NO"} shares.`);
  }
  if (intent.kind === "market" && filledQty === 0n && quantity > 0n && !problems.length) problems.push("Nothing fills within the worst price.");
  return {
    intent,
    fills,
    filledQty,
    filledQuote,
    avgPerShare: filledQty > 0n ? filledQuote / filledQty : null,
    restQty,
    limitPriceBps,
    escrow,
    droppedFills: 0,
    problems,
  };
}

/** Reserved balances from the wallet's resting orders (§10.3 "available and reserved"). */
export function reservedOf(orders: readonly WalletOrder[], market?: string) {
  let musd = 0n;
  let yes = 0n;
  let no = 0n;
  for (const o of orders) {
    if (market && o.market !== market) continue;
    if (o.side === OrderSide.Buy) musd += quote(o.remainingQty, o.priceBps);
    else if (o.outcome === Outcome.Yes) yes += o.remainingQty;
    else no += o.remainingQty;
  }
  return { musd, yes, no };
}

/** Redemption value of holdings in a resolved market (base units). */
export function redemptionValue(outcome: MarketOutcomeName, yes: bigint, no: bigint): bigint {
  if (outcome === "yes") return yes * PAYOUT_PER_SHARE;
  if (outcome === "no") return no * PAYOUT_PER_SHARE;
  if (outcome === "invalid") return (yes + no) * INVALID_PAYOUT_PER_SHARE;
  return 0n;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

/** A readable failure (simulation or confirmation). The message is plain words only. */
export class ExchangeTxError extends Error {
  constructor(
    message: string,
    readonly programLogs: readonly string[] = [],
  ) {
    super(message);
    this.name = "ExchangeTxError";
  }
}

function describeFailure(err: unknown, logs: readonly string[]): string {
  const named = describeExchangeError(logs);
  if (named) return named.replace(/^\w+: /, "");
  const text = `${JSON.stringify(err ?? "")} ${logs.join("\n")}`;
  if (/insufficient lamports|insufficient funds for fee|AccountNotFound|no record of a prior credit/i.test(text)) return "Not enough Devnet SOL to pay the network fee.";
  if (/insufficient funds/i.test(text)) return "Not enough tokens in your wallet for this order.";
  if (/AccountNotInitialized|3012/.test(text)) return "A token account this order needs doesn't exist yet.";
  if (/BlockhashNotFound/i.test(text)) return "The network moved on before the transaction was sent. Try again.";
  return "The transaction would fail. Refresh and try again.";
}

type MarketKeys = { address: PublicKey; round: PublicKey; yesMint: PublicKey; noMint: PublicKey; vault: PublicKey };
const keysOf = (m: Pick<MarketSummary, "address" | "round" | "yesMint" | "noMint" | "vault">): MarketKeys => ({
  address: new PublicKey(m.address),
  round: new PublicKey(m.round),
  yesMint: new PublicKey(m.yesMint),
  noMint: new PublicKey(m.noMint),
  vault: new PublicKey(m.vault),
});

const ataIx = (payer: PublicKey, mint: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ataOf(mint, payer), payer, mint, TOKEN_PROGRAM_ID);

/** Simulates without signatures; throws ExchangeTxError in plain words when it would fail. */
export async function simulate(ixs: TransactionInstruction[], payer: PublicKey): Promise<void> {
  const conn = exchangeConnection();
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage();
  const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
  if (sim.value.err !== null) throw new ExchangeTxError(describeFailure(sim.value.err, sim.value.logs ?? []), sim.value.logs ?? []);
}

/** Simulate, then one wallet prompt, then confirm by polling signature status. */
async function sendOne(wallet: WalletSigner, ixs: TransactionInstruction[], opts?: WriteOptions): Promise<TxResult[]> {
  if (USE_FIXTURES) throw new FixtureModeError();
  const conn = exchangeConnection();
  opts?.onProgress?.({ stage: "building" });
  await simulate(ixs, wallet.publicKey);
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash });
  tx.add(...ixs);
  opts?.onProgress?.({ stage: "signing", total: 1 });
  let signature: string;
  if (wallet.sendTransaction) {
    signature = await wallet.sendTransaction(tx, conn, { preflightCommitment: "confirmed" });
  } else {
    const signed = await wallet.signTransaction(tx);
    signature = await conn.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
  }
  opts?.onProgress?.({ stage: "sending", index: 0, total: 1 });
  const t0 = performance.now();
  for (;;) {
    const st = (await conn.getSignatureStatuses([signature])).value[0];
    if (st?.err) {
      const got = await conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }).catch(() => null);
      throw new ExchangeTxError(describeFailure(st.err, got?.meta?.logMessages ?? []), got?.meta?.logMessages ?? []);
    }
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new ExchangeTxError("The transaction expired before it confirmed. Try again.");
    await new Promise((r) => setTimeout(r, 800));
  }
  const result = { signature, explorerUrl: explorerTx(signature), latencyMs: Math.round(performance.now() - t0) };
  opts?.onProgress?.({ stage: "confirmed", index: 0, total: 1, result });
  return [result];
}

/** Instructions for a trade from a preview. A limit order drops trailing matches to fit one transaction. */
export async function buildTrade(
  wallet: PublicKey,
  market: MarketSummary,
  book: readonly BookOrder[],
  preview: TradePreview,
): Promise<{ ixs: TransactionInstruction[]; preview: TradePreview }> {
  const p = exchangeProgram();
  const usd = await collateralMint();
  const m = keysOf(market);
  const { outcome, side } = preview.intent;
  const prefix = [ataIx(wallet, usd), ataIx(wallet, m.yesMint), ataIx(wallet, m.noMint)];
  const byId = new Map(book.map((o) => [o.id, o]));
  if (preview.intent.kind === "market") {
    const takes = await Promise.all(
      preview.fills.map((f) => {
        const o = byId.get(f.orderId);
        if (!o) throw new ExchangeTxError("The book changed. Review the new preview.");
        return takeOrderIx(p, m, wallet, usd, { address: o.id, maker: o.maker, outcome: o.outcome, side: o.side, seq: o.seq }, f.qty, preview.limitPriceBps);
      }),
    );
    return { ixs: [...prefix, ...takes], preview };
  }
  const placed = await placeOrderIx(p, m, wallet, usd, { clientNonce: randomNonce(), outcome, side, priceBps: preview.limitPriceBps, quantity: preview.intent.quantity });
  const mine = { address: placed.order.toBase58(), maker: wallet.toBase58(), outcome };
  const matches: TransactionInstruction[][] = [];
  for (const f of preview.fills.slice(0, MAX_MATCH_LEVELS)) {
    const o = byId.get(f.orderId);
    if (!o) throw new ExchangeTxError("The book changed. Review the new preview.");
    const resting = { address: o.id, maker: o.maker, outcome: o.outcome };
    matches.push(side === OrderSide.Sell ? await matchOrdersIx(p, m, wallet, usd, resting, mine, f.qty) : await matchOrdersIx(p, m, wallet, usd, mine, resting, f.qty));
  }
  // Only the ATA the order receives into is needed up front (the escrowed side already exists).
  const receive = side === OrderSide.Sell ? ataIx(wallet, usd) : ataIx(wallet, outcome === Outcome.Yes ? m.yesMint : m.noMint);
  const fake = "11111111111111111111111111111111";
  let kept = matches.length;
  while (kept > 0 && measureTransactionSize([receive, placed.ix, ...matches.slice(0, kept).flat()], wallet, fake) > MAX_TX_BYTES) kept--;
  const droppedFills = matches.length - kept;
  const keptFills = preview.fills.slice(0, kept);
  const filledQty = keptFills.reduce((a, f) => a + f.qty, 0n);
  const filledQuote = keptFills.reduce((a, f) => a + f.quote, 0n);
  return {
    ixs: [receive, placed.ix, ...matches.slice(0, kept).flat()],
    preview: {
      ...preview,
      fills: keptFills,
      filledQty,
      filledQuote,
      avgPerShare: filledQty > 0n ? filledQuote / filledQty : null,
      restQty: preview.intent.quantity - filledQty,
      droppedFills,
    },
  };
}

export function sendTrade(wallet: WalletSigner, ixs: TransactionInstruction[], opts?: WriteOptions): Promise<TxResult[]> {
  return sendOne(wallet, ixs, opts);
}

export async function cancelOrder(wallet: WalletSigner, market: MarketSummary, order: WalletOrder, opts?: WriteOptions): Promise<TxResult[]> {
  const ix = await cancelOrderIx(exchangeProgram(), keysOf(market), wallet.publicKey, await collateralMint(), order);
  return sendOne(wallet, [ix], opts);
}

/**
 * Redeem (§10.3): one transaction sweeps the wallet's remaining orders in this market and redeems
 * every winning share it then holds (YES or NO; both at 0.50 on Invalid).
 */
export async function buildRedeem(
  wallet: PublicKey,
  market: MarketSummary,
  orders: readonly WalletOrder[],
  holdings: { yes: bigint; no: bigint },
): Promise<TransactionInstruction[]> {
  const p = exchangeProgram();
  const usd = await collateralMint();
  const m = keysOf(market);
  const mine = orders.filter((o) => o.market === market.address);
  const sweeps = await Promise.all(mine.map((o) => sweepOrderIx(p, m, wallet, usd, o)));
  // Shares coming back from swept SELL escrows count toward the redemption.
  const back = { yes: 0n, no: 0n };
  for (const o of mine) if (o.side === OrderSide.Sell) back[o.outcome === Outcome.Yes ? "yes" : "no"] += o.remainingQty;
  const yes = holdings.yes + back.yes;
  const no = holdings.no + back.no;
  const ixs: TransactionInstruction[] = [ataIx(wallet, usd), ...sweeps];
  if ((market.outcome === "yes" || market.outcome === "invalid") && yes > 0n) ixs.push(await redeemIx(p, m, wallet, usd, Outcome.Yes, yes));
  if ((market.outcome === "no" || market.outcome === "invalid") && no > 0n) ixs.push(await redeemIx(p, m, wallet, usd, Outcome.No, no));
  return ixs;
}

export function sendRedeem(wallet: WalletSigner, ixs: TransactionInstruction[], opts?: WriteOptions): Promise<TxResult[]> {
  return sendOne(wallet, ixs, opts);
}

// ---------------------------------------------------------------------------
// Operator (password; keys stay on the server)
// ---------------------------------------------------------------------------

export type OperatorAction = "status" | "close" | "reject" | "resolve" | "sweep";

export async function operatorStep(action: OperatorAction, password: string, round?: string): Promise<{ ok: boolean; status: number; body: J }> {
  if (USE_FIXTURES) throw new FixtureModeError();
  const res = await fetch("/api/operator/settle-round", {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-password": password },
    body: JSON.stringify({ action, round }),
  });
  let body: J = {};
  try {
    body = (await res.json()) as J;
  } catch {
    /* non-JSON */
  }
  return { ok: res.ok, status: res.status, body };
}
