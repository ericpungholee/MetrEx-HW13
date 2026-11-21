// Live book of one market (spec-v2 §7.1): getProgramAccounts(Order) with a memcmp on `market`,
// the makers' receiving ATAs checked, projected with the pure rules in @metrex/exchange.
// `BookCache` keeps a 2 s in-memory snapshot; nothing survives a restart, and nothing needs to.

import { PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo, type Commitment, type Connection } from "@solana/web3.js";
import { findMarketPda, findRoundPda, projectBook, type BookOrder, type OrderAccount } from "@metrex/exchange";
import {
  accountsExist,
  ataOf,
  chainNow,
  clockUnixTimestamp,
  decodeConfigAccount,
  decodeMarketAccount,
  decodeOrderAccount,
  decodeRoundAccount,
  exchangeConfigPda,
  fetchExchangeMarket,
  fetchMarketsOfRound,
  fetchOrders,
  fetchPropertyIds,
  fetchRound,
  receiveMintOf,
  type ConfigView,
  type MarketView,
  type RoundView,
} from "./accounts";
import { getExchangeProgram, type ExchangeProgram } from "./program";

export interface MarketBookSnapshot {
  market: MarketView;
  round: RoundView;
  now: bigint;
  tradingOpen: boolean;
  /** Every Order account of the market, including hidden ones. */
  orders: OrderAccount[];
  /** Active orders only (§7.1 hiding rules). */
  book: BookOrder[];
  fetchedAt: number;
}

function snapshotOf(
  market: MarketView,
  round: RoundView,
  now: bigint,
  orders: OrderAccount[],
  receiveAtaExists: (o: OrderAccount) => boolean,
): MarketBookSnapshot {
  const tradingOpen = round.status === "open" && now < round.tradingEndsAt;
  const book = projectBook(orders, { tradingOpen, unresolved: market.outcome === "unresolved", now, receiveAtaExists });
  return { market, round, now, tradingOpen, orders, book, fetchedAt: Date.now() };
}

export async function loadMarketBook(
  conn: Connection,
  marketKey: PublicKey,
  collateral: PublicKey,
  commitment: Commitment = "confirmed",
): Promise<MarketBookSnapshot | null> {
  const p = getExchangeProgram(conn);
  const market = await fetchExchangeMarket(p, marketKey, commitment);
  if (!market) return null;
  const [round, now, orders] = await Promise.all([
    fetchRound(p, market.round, commitment),
    chainNow(conn, commitment),
    fetchOrders(p, { market: marketKey }),
  ]);
  if (!round) return null;
  const receive = orders.map((o) => ataOf(receiveMintOf(o, market, collateral), new PublicKey(o.maker)));
  const exists = await accountsExist(conn, receive, commitment);
  const present = new Map(orders.map((o, i) => [o.address, exists[i] ?? false]));
  return snapshotOf(market, round, now, orders, (o) => present.get(o.address) ?? false);
}

export interface ExchangeState {
  config: ConfigView;
  /** The selected rounds (the last `roundsBack`), oldest first. */
  rounds: RoundView[];
  /** One snapshot per market of the selected rounds, by round then property. */
  snapshots: MarketBookSnapshot[];
  /** Markets whose new order addresses have not all been read into this snapshot. */
  orderDiscoveryPending: ReadonlySet<string>;
  now: bigint;
  /** Accounts asked for through `extraKeys` (null when missing), keyed by base58. */
  extra: Map<string, AccountInfo<Buffer> | null>;
}

export interface ExchangeStateOptions {
  roundsBack?: number;
  /** Extra accounts to read in the same batch (balances the caller needs). */
  extraKeys?: (markets: MarketView[], config: ConfigView) => PublicKey[];
  commitment?: Commitment;
}

/** A market's order scan is trusted once it saw the newest seq, or after this many retries. */
const ORDER_SCAN_RETRIES = 3;

/**
 * Every book of the last `roundsBack` rounds, for pollers (bots, keeper). Hosted RPC tiers allow
 * plenty of getMultipleAccounts but only about one getProgramAccounts a second, so steady state
 * uses no scans at all: three batched reads per load (Config + Clock; Rounds at their PDAs from
 * `next_round_id`, each round's Markets at their PDAs from the registered property ids, and the
 * cached Order addresses; the makers' receiving ATAs plus `extraKeys`). A new market is therefore
 * seen in the first load after it lands. Property ids are rescanned only when a round counts more
 * markets than the known properties explain, and a market's orders only when its
 * `next_order_seq` moves (only `place_order` moves it). Orders that fill or
 * cancel are seen through the batched read; a missing account is a closed order. Keep one loader
 * per process: the caches are what make it cheap. Same projection as `loadMarketBook`.
 */
/** How long an order added with `addKnownOrders` may read as missing before it counts as closed. */
const KNOWN_ORDER_GRACE_MS = 15_000;

export class ExchangeStateLoader {
  private propertyIds: number[] | null = null;
  private readonly ordersOfMarket = new Map<string, { seq: bigint; keys: PublicKey[]; retries: number }>();
  /** getProgramAccounts scans made so far. */
  scans = 0;

  async load(conn: Connection, opts: ExchangeStateOptions = {}): Promise<ExchangeState | null> {
    const commitment = opts.commitment ?? "confirmed";
    const p = getExchangeProgram(conn);
    const multi = async (keys: readonly PublicKey[]): Promise<Map<string, AccountInfo<Buffer> | null>> => {
      const out = new Map<string, AccountInfo<Buffer> | null>();
      const uniq = [...new Map(keys.map((k) => [k.toBase58(), k])).values()];
      for (let i = 0; i < uniq.length; i += 100) {
        const chunk = uniq.slice(i, i + 100);
        const got = await conn.getMultipleAccountsInfo(chunk, commitment);
        chunk.forEach((k, j) => out.set(k.toBase58(), got[j] ?? null));
      }
      return out;
    };

    // 1. Config and Clock.
    const cfgKey = exchangeConfigPda(p);
    const first = await multi([cfgKey, SYSVAR_CLOCK_PUBKEY]);
    const cfgInfo = first.get(cfgKey.toBase58());
    const clock = first.get(SYSVAR_CLOCK_PUBKEY.toBase58());
    if (!cfgInfo) return null;
    if (!clock) throw new Error("Clock sysvar unavailable");
    const config = decodeConfigAccount(p, cfgKey, cfgInfo.data);
    const now = clockUnixTimestamp(clock.data);

    // 2. Rounds, their Markets and the cached Orders at their PDAs, in one batch.
    const back = BigInt(opts.roundsBack ?? 3);
    const roundKeys: PublicKey[] = [];
    for (let id = config.nextRoundId - back; id < config.nextRoundId; id++) if (id >= 0n) roundKeys.push(findRoundPda(p.programId, id)[0]);
    if (!this.propertyIds) {
      this.scans++;
      this.propertyIds = await fetchPropertyIds(p);
    }
    const marketKeysOf = (round: PublicKey, ids: readonly number[]) => ids.map((id) => findMarketPda(p.programId, round, id)[0]);
    const derived = roundKeys.flatMap((r) => marketKeysOf(r, this.propertyIds!));
    const cachedOrders = derived.flatMap((m) => this.ordersOfMarket.get(m.toBase58())?.keys ?? []);
    const batch = await multi([...roundKeys, ...derived, ...cachedOrders]);
    const rounds = roundKeys.flatMap((k) => {
      const info = batch.get(k.toBase58());
      return info ? [decodeRoundAccount(p, k, info.data)] : [];
    });

    // 3. Markets at their PDAs (round, property_id). If a round counts more markets than found,
    //    a property was registered since: refresh the ids once, then fall back to a scan.
    const markets: MarketView[] = [];
    let refreshed = false;
    for (const r of rounds) {
      const found = marketKeysOf(r.address, this.propertyIds).flatMap((k) => {
        const info = batch.get(k.toBase58());
        return info ? [decodeMarketAccount(p, k, info.data)] : [];
      });
      if (found.length < r.marketCount) {
        if (!refreshed) {
          refreshed = true;
          this.scans++;
          this.propertyIds = await fetchPropertyIds(p);
        }
        const more = await multi(marketKeysOf(r.address, this.propertyIds));
        const viaPda = [...more].flatMap(([k, info]) => (info ? [decodeMarketAccount(p, new PublicKey(k), info.data)] : []));
        if (viaPda.length >= r.marketCount) markets.push(...viaPda);
        else {
          this.scans++;
          markets.push(...(await fetchMarketsOfRound(p, r.address)));
        }
      } else markets.push(...found);
    }
    const roundIndex = new Map(rounds.map((r, i) => [r.address.toBase58(), i]));
    markets.sort((a, b) => roundIndex.get(a.round.toBase58())! - roundIndex.get(b.round.toBase58())! || a.propertyId - b.propertyId);

    // 4. Orders from the batched read of known addresses. A moved next_order_seq means orders by
    //    makers we don't know yet; they are found by a scan in the background, so a slow or lagging
    //    getProgramAccounts never holds up a load. Only a market seen for the first time with orders
    //    on it waits for its scan; a brand-new market (next_order_seq ≤ 1) has none.
    const roundOf = new Map(rounds.map((r) => [r.address.toBase58(), r]));
    const requested = new Set(cachedOrders.map((k) => k.toBase58()));
    const byMarket = new Map<string, OrderAccount[]>();
    const orderDiscoveryPending = new Set<string>();
    for (const m of markets) {
      const mk = m.address.toBase58();
      let cached = this.ordersOfMarket.get(mk);
      if (!cached && m.nextOrderSeq <= 1n) {
        cached = { seq: m.nextOrderSeq, keys: [], retries: 0 };
        this.ordersOfMarket.set(mk, cached);
      }
      if (!cached) {
        const orders = await this.scanOrders(p, m, roundOf.get(m.round.toBase58()), now);
        if (this.ordersOfMarket.get(mk)?.seq !== m.nextOrderSeq) orderDiscoveryPending.add(mk);
        byMarket.set(mk, orders);
        continue;
      }
      if (cached.seq !== m.nextOrderSeq) {
        orderDiscoveryPending.add(mk);
        void this.scanInBackground(p, m, roundOf.get(m.round.toBase58()), now);
      }
      const live: OrderAccount[] = [];
      const kept: PublicKey[] = [];
      for (const k of cached.keys) {
        const ks = k.toBase58();
        if (!requested.has(ks)) {
          orderDiscoveryPending.add(mk);
          kept.push(k); // added after this load's read (own placement or a scan): read next load
          continue;
        }
        const info = batch.get(ks);
        if (info) {
          live.push(decodeOrderAccount(p, k, info.data));
          kept.push(k);
          this.unseen.delete(ks);
        } else if ((this.unseen.get(ks) ?? 0) > Date.now() - KNOWN_ORDER_GRACE_MS) kept.push(k); // a lagging node
        else this.unseen.delete(ks);
      }
      cached.keys = kept;
      byMarket.set(mk, live);
    }

    // 5. Receiving ATAs (book hiding rule) and the caller's extra keys.
    const receiveKey = new Map<string, string>();
    const keys: PublicKey[] = [];
    for (const m of markets) {
      for (const o of byMarket.get(m.address.toBase58()) ?? []) {
        const k = ataOf(receiveMintOf(o, m, config.collateralMint), new PublicKey(o.maker));
        receiveKey.set(o.address, k.toBase58());
        keys.push(k);
      }
    }
    const extraKeys = opts.extraKeys?.(markets, config) ?? [];
    const infos = await multi([...keys, ...extraKeys]);
    const snapshots = markets.map((m) =>
      snapshotOf(m, roundOf.get(m.round.toBase58())!, now, byMarket.get(m.address.toBase58()) ?? [], (o) => {
        const k = receiveKey.get(o.address);
        return k !== undefined && (infos.get(k) ?? null) !== null;
      }),
    );
    const extra = new Map<string, AccountInfo<Buffer> | null>();
    for (const k of extraKeys) extra.set(k.toBase58(), infos.get(k.toBase58()) ?? null);
    return { config, rounds, snapshots, orderDiscoveryPending, now, extra };
  }

  /** Order addresses the caller knows exist (its own confirmed placements): read from the next load on. */
  addKnownOrders(market: PublicKey, orders: readonly PublicKey[]): void {
    const mk = market.toBase58();
    const cached = this.ordersOfMarket.get(mk) ?? { seq: -1n, keys: [], retries: 0 };
    const have = new Set(cached.keys.map((k) => k.toBase58()));
    for (const o of orders) {
      if (!have.has(o.toBase58())) cached.keys.push(o);
      this.unseen.set(o.toBase58(), Date.now());
    }
    this.ordersOfMarket.set(mk, cached);
  }

  /** Known order keys not yet read back, and when they were added (a missing account isn't closed yet). */
  private readonly unseen = new Map<string, number>();

  private readonly scanning = new Set<string>();

  private scanInBackground(p: ExchangeProgram, m: MarketView, r: RoundView | undefined, now: bigint): Promise<void> {
    const mk = m.address.toBase58();
    if (this.scanning.has(mk)) return Promise.resolve();
    this.scanning.add(mk);
    return this.scanOrders(p, m, r, now)
      .then(
        () => undefined,
        () => undefined, // retried on a later load: seq still differs
      )
      .finally(() => this.scanning.delete(mk));
  }

  /**
   * Scans a market's orders and merges them into the cache. The scan may lag the market account
   * on a load-balanced RPC: its seq is trusted once it shows the newest order (seq next-1) or after
   * a few retries (that order may already be closed). A market that can't trade can't gain orders,
   * so its scan is final.
   */
  private async scanOrders(p: ExchangeProgram, m: MarketView, r: RoundView | undefined, now: bigint): Promise<OrderAccount[]> {
    this.scans++;
    const mk = m.address.toBase58();
    const orders = await fetchOrders(p, { market: m.address });
    const canTrade = !!r && r.status === "open" && now < r.tradingEndsAt && m.outcome === "unresolved";
    const sawNewest = !canTrade || m.nextOrderSeq <= 1n || orders.some((o) => o.seq === m.nextOrderSeq - 1n);
    const prev = this.ordersOfMarket.get(mk);
    const retries = prev && prev.seq === -1n ? prev.retries + 1 : 0;
    const trusted = sawNewest || retries >= ORDER_SCAN_RETRIES;
    const keys = [...(prev?.keys ?? [])];
    const have = new Set(keys.map((k) => k.toBase58()));
    for (const o of orders) if (!have.has(o.address)) keys.push(new PublicKey(o.address));
    this.ordersOfMarket.set(mk, { seq: trusted ? m.nextOrderSeq : -1n, keys, retries });
    return orders;
  }
}

/** One-shot load (no cache reuse). Pollers should keep an `ExchangeStateLoader` instead. */
export function loadExchangeState(conn: Connection, opts: ExchangeStateOptions = {}): Promise<ExchangeState | null> {
  return new ExchangeStateLoader().load(conn, opts);
}

/** SPL token amount of a fetched account (0 when missing). */
export const tokenAmountOf = (info: AccountInfo<Buffer> | null | undefined): bigint =>
  info && info.data.length >= 72 ? info.data.readBigUInt64LE(64) : 0n;

/** Per-market snapshot cache. `get` refetches when older than `ttlMs`; `invalidate` after own sends. */
export class BookCache {
  private readonly snaps = new Map<string, MarketBookSnapshot>();
  private readonly inflight = new Map<string, Promise<MarketBookSnapshot | null>>();

  constructor(
    private readonly getConn: () => Connection,
    private readonly collateral: PublicKey,
    private readonly ttlMs = 2_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(market: PublicKey): Promise<MarketBookSnapshot | null> {
    const k = market.toBase58();
    const s = this.snaps.get(k);
    if (s && this.now() - s.fetchedAt < this.ttlMs) return s;
    let p = this.inflight.get(k);
    if (!p) {
      p = loadMarketBook(this.getConn(), market, this.collateral).then((snap) => {
        if (snap) this.snaps.set(k, snap);
        else this.snaps.delete(k);
        return snap;
      });
      p.finally(() => this.inflight.delete(k)).catch(() => undefined);
      this.inflight.set(k, p);
    }
    return p;
  }

  invalidate(market?: PublicKey): void {
    if (market) this.snaps.delete(market.toBase58());
    else this.snaps.clear();
  }
}
