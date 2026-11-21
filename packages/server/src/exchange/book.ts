// Live book of one market (spec-v2 §7.1): getProgramAccounts(Order) with a memcmp on `market`,
// the makers' receiving ATAs checked, projected with the pure rules in @metrex/exchange.
// `BookCache` keeps a 2 s in-memory snapshot; nothing survives a restart, and nothing needs to.

import { PublicKey, type Commitment, type Connection } from "@solana/web3.js";
import { projectBook, type BookOrder, type OrderAccount } from "@metrex/exchange";
import {
  accountsExist,
  ataOf,
  chainNow,
  fetchExchangeMarket,
  fetchOrders,
  fetchRound,
  receiveMintOf,
  type MarketView,
  type RoundView,
} from "./accounts";
import { getExchangeProgram } from "./program";

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
  const tradingOpen = round.status === "open" && now < round.tradingEndsAt;
  const book = projectBook(orders, {
    tradingOpen,
    unresolved: market.outcome === "unresolved",
    now,
    receiveAtaExists: (o) => present.get(o.address) ?? false,
  });
  return { market, round, now, tradingOpen, orders, book, fetchedAt: Date.now() };
}

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
