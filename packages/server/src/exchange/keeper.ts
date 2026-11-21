// Keeper (spec-v2 §7.4): clears crosses left by client races and sweeps orders after a round closes.
// Acts only on orders seen at `confirmed`, keeps one in-flight match per order, refetches after any
// failure and never assumes success. The keeper key has no authority; rent always returns to makers.

import type { Keypair, PublicKey } from "@solana/web3.js";
import { planKeeperMatches, type OrderAccount } from "@metrex/exchange";
import { ExchangeStateLoader, type MarketBookSnapshot } from "./book";
import { matchOrdersIx, sweepOrderIx } from "./ix";
import { getExchangeProgram } from "./program";
import { explorerTx } from "../explorer";
import type { RpcPool } from "../rpc";
import { sendTx } from "../tx";
import { describeExchangeError } from "@metrex/exchange";

export interface KeeperStats {
  ticks: number;
  matches: number;
  sweeps: number;
  failures: number;
  lastError: string | null;
  lastSignature: string | null;
}

/** Orders `sweep_order` accepts (§5.8): round Closed, past the deadline, expired, or fully filled. */
export function sweepable(o: OrderAccount, s: Pick<MarketBookSnapshot, "round" | "now">): boolean {
  return (
    s.round.status === "closed" ||
    s.now >= s.round.tradingEndsAt ||
    (o.expiresAt !== 0n && s.now >= o.expiresAt) ||
    o.remainingQty === 0n
  );
}

export class Keeper {
  readonly stats: KeeperStats = { ticks: 0, matches: 0, sweeps: 0, failures: 0, lastError: null, lastSignature: null };
  private readonly inFlight = new Set<string>();
  private readonly loader = new ExchangeStateLoader();

  constructor(
    private readonly o: {
      rpc: RpcPool;
      keeper: Keypair;
      /** Rounds to look back for sweeping (latest included). */
      roundsBack?: number;
      /** Also sweep fully filled orders in open rounds (default false: makers reuse them). */
      sweepFilledWhileOpen?: boolean;
      log?: (line: string) => void;
    },
  ) {}

  private log(line: string): void {
    (this.o.log ?? ((l: string) => console.log(`${new Date().toISOString()} ${l}`)))(line);
  }

  private send(ixs: Parameters<typeof sendTx>[1]): Promise<string> {
    return sendTx(this.o.rpc.connection, ixs, [this.o.keeper], { describe: describeExchangeError });
  }

  async tick(): Promise<void> {
    this.stats.ticks++;
    // One batched read of every book (a fixed handful of RPC calls), then act market by market.
    const state = await this.o.rpc.run((c) => this.loader.load(c, { roundsBack: this.o.roundsBack ?? 8 }));
    if (!state) return;
    const collateral = state.config.collateralMint;
    for (const snap of state.snapshots) {
      if (snap.tradingOpen && snap.market.outcome === "unresolved") await this.matchMarket(snap, collateral);
      await this.sweepMarket(snap, collateral);
    }
  }

  /** One `match_orders` per planned pair, each order at most once in flight. */
  async matchMarket(snap: MarketBookSnapshot, collateral: PublicKey): Promise<number> {
    const prog = getExchangeProgram(this.o.rpc.connection);
    let done = 0;
    for (const p of planKeeperMatches(snap.book, this.inFlight)) {
      this.inFlight.add(p.buy.id);
      this.inFlight.add(p.sell.id);
      try {
        const ixs = await matchOrdersIx(
          prog,
          snap.market,
          this.o.keeper.publicKey,
          collateral,
          { address: p.buy.id, maker: p.buy.maker, outcome: p.outcome },
          { address: p.sell.id, maker: p.sell.maker },
          p.quantity,
        );
        const sig = await this.send(ixs);
        this.stats.matches++;
        this.stats.lastSignature = sig;
        done++;
        this.log(`[keeper] match ${p.quantity} @ ${p.priceBps} ${p.outcome === 0 ? "YES" : "NO"} on ${snap.market.address.toBase58()} ${explorerTx(sig)}`);
      } catch (e) {
        this.stats.failures++;
        this.stats.lastError = (e as Error).message;
        this.log(`[keeper] match failed (refetching next tick): ${(e as Error).message}`);
      } finally {
        this.inFlight.delete(p.buy.id);
        this.inFlight.delete(p.sell.id);
      }
    }
    return done;
  }

  /** Permissionless sweeps in batches; a failed batch is retried one order at a time. */
  async sweepMarket(snap: MarketBookSnapshot, collateral: PublicKey, batch = 2): Promise<number> {
    const open = snap.tradingOpen && snap.market.outcome === "unresolved";
    const todo = snap.orders.filter((o) => sweepable(o, snap) && (!open || this.o.sweepFilledWhileOpen || o.expiresAt !== 0n));
    if (!todo.length) return 0;
    const prog = getExchangeProgram(this.o.rpc.connection);
    let done = 0;
    const one = async (orders: OrderAccount[]): Promise<boolean> => {
      try {
        const ixs = await Promise.all(orders.map((o) => sweepOrderIx(prog, snap.market, this.o.keeper.publicKey, collateral, o)));
        const sig = await this.send(ixs);
        this.stats.sweeps += orders.length;
        this.stats.lastSignature = sig;
        done += orders.length;
        this.log(`[keeper] swept ${orders.length} on ${snap.market.address.toBase58()} ${explorerTx(sig)}`);
        return true;
      } catch (e) {
        this.stats.lastError = (e as Error).message;
        return false;
      }
    };
    for (let i = 0; i < todo.length; i += batch) {
      const chunk = todo.slice(i, i + batch);
      if (!(await one(chunk)) && chunk.length > 1) for (const o of chunk) await one([o]);
    }
    return done;
  }
}
