// Simulation worker (docs/spec-simulation.md §4, §5): thin I/O around the pure decisions in
// strategy.ts. One batched chain read per tick; every trade is a real, signed Devnet transaction
// with the sponsor as fee payer and the trader as owner. Imports only the oracle-free
// "@metrex/server/exchange" entry (spec-v2 §8.4).

import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, Transaction, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import {
  CATALOG,
  OrderSide,
  Outcome,
  planMarketOrder,
  randomNonce,
  type BookOrder,
  type CatalogMarket,
  type OrderAccount,
  type OutcomeCode,
} from "@metrex/exchange";
import {
  ataOf,
  cancelOrderIx,
  escrowMintOf,
  explorerTx,
  getExchangeProgram,
  ExchangeStateLoader,
  fullResetHeld,
  isClosureHeld,
  readDemoOperation,
  simulationPaused,
  mergeIx,
  placeOrderIx,
  receiveMintOf,
  redeemIx,
  sendExchangeTx,
  splitIx,
  takeOrderIx,
  tokenAmountOf,
  writeHeartbeat,
  type ExchangeProgram,
  type MarketBookSnapshot,
  type RpcPool,
} from "@metrex/server/exchange";
import { signalAt, bulletinsBetween } from "./info";
import { MidHistory, quotesOf, yesMidBps, type MarketCtx } from "./market";
import type { TraderProfile } from "./population";
import { rngFrom, type Rng } from "./rng";
import { decide, remember, staleOrders, type Holdings, type SimAction, type TraderMemory } from "./strategy";

export interface SimTrader {
  profile: TraderProfile;
  keypair: Keypair;
  memory: Map<string, TraderMemory>;
}

export interface SimWorkerOptions {
  rpc: RpcPool;
  sponsor: Keypair;
  traders: SimTrader[];
  seed: string;
  /** Activity multiplier on every trader's rate. */
  rate: number;
  maxInFlight: number;
  roundsBack?: number;
  /** Below this sponsor balance no new trades start (default 0.1 SOL). */
  sponsorFloorLamports?: bigint;
  heartbeat?: boolean;
  log?: (line: string) => void;
}

const MAX_TX_BYTES = 1232;

/** Whether `ixs` fit one transaction with `signers` signatures. */
export function fits(ixs: TransactionInstruction[], payer: PublicKey, signers: number): boolean {
  try {
    const tx = new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() }).add(...ixs);
    return tx.serializeMessage().length + 1 + 64 * signers <= MAX_TX_BYTES;
  } catch {
    return false;
  }
}

const asOrder = (o: BookOrder) => ({ address: o.id, maker: o.maker, outcome: o.outcome, side: o.side, seq: o.seq });

interface Live {
  snap: MarketBookSnapshot;
  entry: CatalogMarket;
  /** Newest round of its scenario (the one the homepage features). */
  featured: boolean;
}

export class SimWorker {
  private readonly log: (line: string) => void;
  private readonly loader = new ExchangeStateLoader();
  private readonly history = new Map<string, MidHistory>();
  private readonly busy = new Map<string, Promise<void>>();
  private readonly settledAt = new Map<string, number>();
  private readonly cooldownUntil = new Map<string, number>();
  private readonly rng: Rng;
  private lastTickMs = Date.now();
  private rateMult = 1;
  private ticks = 0;
  private sent = 0;
  private failed = 0;
  private fillsSubmitted = 0;
  private volume = 0n;
  private recentFills: Array<{ t: number; n: number }> = [];
  private lastError: string | null = null;
  private lastBulletin: string | null = null;
  /** The demo operation already accounted for when this process started (no clearing for it). */
  private lastResetId: string | null = readDemoOperation()?.id ?? null;

  constructor(private readonly o: SimWorkerOptions) {
    this.log = o.log ?? ((l) => console.log(`${new Date().toISOString()} ${l}`));
    this.rng = rngFrom(`${o.seed}:decisions:${Date.now()}`);
  }

  private get program(): ExchangeProgram {
    return getExchangeProgram(this.o.rpc.connection);
  }

  async tick(): Promise<void> {
    this.ticks++;
    // Reset Demo (docs/spec-simulation.md §9) signs for every trader: stop, drain, acknowledge.
    if (fullResetHeld()) {
      this.beat({ state: "reset_hold", inFlight: this.busy.size, traders: this.o.traders.length });
      return;
    }
    // A completed reset starts every trader's strategy afresh (beliefs, holding clocks, mid history).
    const op = readDemoOperation();
    if (op?.action === "reset_demo" && op.completed && op.id !== this.lastResetId) {
      for (const t of this.o.traders) t.memory.clear();
      this.history.clear();
      this.log(`[sim] strategy state reset after demo reset ${op.id}`);
      this.lastResetId = op.id;
    }
    const paused = simulationPaused();
    // Degrade gracefully when the fee sponsor runs low: stop opening trades, keep unwinding.
    const loadStarted = Date.now();
    const dtMs = Math.min(30_000, loadStarted - this.lastTickMs);
    this.lastTickMs = loadStarted;
    const catalogProps = new Set(CATALOG.map((c) => c.propertyId));
    const state = await this.o.rpc.run((c) =>
      this.loader.load(c, {
        roundsBack: this.o.roundsBack ?? 8,
        extraKeys: (markets, config) => {
          const mine = markets.filter((m) => catalogProps.has(m.propertyId));
          return this.o.traders.flatMap((t) => {
            const me = t.keypair.publicKey;
            return [me, ataOf(config.collateralMint, me), ...mine.flatMap((m) => [ataOf(m.yesMint, me), ataOf(m.noMint, me)])];
          }).concat([this.o.sponsor.publicKey]);
        },
      }),
    );
    if (!state) {
      this.beat({ state: "waiting_for_config" });
      return;
    }
    const collateral = state.config.collateralMint;
    const has = (k: PublicKey) => (state.extra.get(k.toBase58()) ?? null) !== null;
    const bal = (mint: PublicKey, owner: PublicKey) => tokenAmountOf(state.extra.get(ataOf(mint, owner).toBase58()));
    const sponsorLamports = BigInt(state.extra.get(this.o.sponsor.publicKey.toBase58())?.lamports ?? 0);
    const lowFunds = sponsorLamports < (this.o.sponsorFloorLamports ?? 100_000_000n);

    // Catalog markets of the loaded rounds; the newest round per scenario is the tradable one.
    const lives: Live[] = [];
    for (const entry of CATALOG) {
      const snaps = state.snapshots.filter((s) => s.market.propertyId === entry.propertyId && s.round.scenarioId === entry.scenarioId);
      snaps.forEach((snap, i) => lives.push({ snap, entry, featured: i === snaps.length - 1 }));
    }
    const ctxs = new Map<string, MarketCtx>();
    for (const l of lives) {
      if (!l.featured || !l.snap.tradingOpen) continue;
      const mk = l.snap.market.address.toBase58();
      const quotes = quotesOf(l.snap.book);
      const mid = yesMidBps(quotes);
      const h = this.history.get(mk) ?? new MidHistory();
      this.history.set(mk, h);
      if (mid !== undefined) h.push(loadStarted, mid);
      const b = bulletinsBetween(this.o.seed, l.entry.hazard, loadStarted - dtMs, loadStarted);
      for (const x of b) {
        this.lastBulletin = `${x.headline} (${x.hazard})`;
        this.log(`[sim] ${x.hazard}: ${x.headline}`);
      }
      ctxs.set(mk, {
        hazard: l.entry.hazard,
        market: mk,
        anchorBps: l.entry.ladder[0]?.refBps ?? 100,
        book: l.snap.book,
        quotes,
        midBps: mid,
        signal: signalAt(this.o.seed, l.entry.hazard, loadStarted),
        momentum: (w) => h.change(loadStarted, w),
        chainNow: l.snap.now,
      });
    }

    let launched = 0;
    for (const t of this.o.traders) {
      const id = t.profile.id;
      if (this.busy.size >= this.o.maxInFlight) break;
      if (this.busy.has(id) || (this.settledAt.get(id) ?? 0) >= loadStarted || (this.cooldownUntil.get(id) ?? 0) > loadStarted) continue;
      const me = t.keypair.publicKey;
      const maker = me.toBase58();
      const musd = bal(collateral, me);
      // Paused: no new trading, but closed and resolved markets still unwind and redeem.
      const job = this.lifecycle(t, lives, collateral, bal, has, maker) ?? (paused || lowFunds ? undefined : this.trade(t, lives, ctxs, collateral, musd, bal, has, dtMs, loadStarted));
      if (!job) continue;
      launched++;
      const run = (job() as Promise<unknown>)
        .then(() => undefined, (e: unknown) => this.fail(t, e))
        .finally(() => {
          this.busy.delete(id);
          this.settledAt.set(id, Date.now());
        });
      this.busy.set(id, run);
    }
    const cutoff = Date.now() - 60_000;
    this.recentFills = this.recentFills.filter((f) => f.t >= cutoff);
    this.beat({
      state: paused ? "paused" : lowFunds ? "low_funds" : "running",
      sponsorLamports: Number(sponsorLamports),
      traders: this.o.traders.length,
      markets: ctxs.size,
      launched,
      inFlight: this.busy.size,
      rateMultiplier: Math.round(this.rateMult * 100) / 100,
      fillsSubmitted: this.fillsSubmitted,
      fillsLastMinute: this.recentFills.reduce((a, f) => a + f.n, 0),
      volumeMusd: Number(this.volume / 1_000_000n),
      lastBulletin: this.lastBulletin,
    });
  }

  async drain(): Promise<void> {
    while (this.busy.size) await Promise.all([...this.busy.values()]);
  }

  /** After close: cancel own orders and merge pairs; after resolution: redeem (same as makers). */
  private lifecycle(t: SimTrader, lives: Live[], collateral: PublicKey, bal: (m: PublicKey, o: PublicKey) => bigint, has: (k: PublicKey) => boolean, maker: string) {
    const me = t.keypair.publicKey;
    for (const { snap } of lives) {
      if (snap.tradingOpen) continue;
      const m = snap.market;
      if (isClosureHeld(m.round)) continue;
      const own = snap.orders.filter((o) => o.maker === maker);
      if (own.length) return () => this.cancel(t, snap, collateral, own, "market closed");
      const yes = bal(m.yesMint, me);
      const no = bal(m.noMint, me);
      if (m.outcome === "unresolved") {
        const pairs = yes < no ? yes : no;
        if (pairs > 0n) return () => this.send(t, snap, [mergeIx(this.program, m, me, collateral, pairs)], `merge ${pairs}`);
        continue;
      }
      const redeem: Array<[OutcomeCode, bigint]> = [];
      if ((m.outcome === "yes" || m.outcome === "invalid") && yes > 0n) redeem.push([Outcome.Yes, yes]);
      if ((m.outcome === "no" || m.outcome === "invalid") && no > 0n) redeem.push([Outcome.No, no]);
      if (redeem.length) {
        return () => this.send(t, snap, redeem.map(([o, q]) => redeemIx(this.program, m, me, collateral, o, q)), `redeem ${redeem.map(([o, q]) => `${q} ${o === 0 ? "YES" : "NO"}`).join(" + ")}`);
      }
      // Rent back to the sponsor that paid it: close emptied outcome accounts of a resolved market.
      const empty = [m.yesMint, m.noMint].filter((mint) => has(ataOf(mint, me)) && bal(mint, me) === 0n);
      if (empty.length) {
        return () => this.send(t, snap, empty.map((mint) => createCloseAccountInstruction(ataOf(mint, me), this.o.sponsor.publicKey, me, [], TOKEN_PROGRAM_ID)), `close ${empty.length} empty account(s), rent to sponsor`);
      }
    }
    return undefined;
  }

  private trade(
    t: SimTrader,
    lives: Live[],
    ctxs: Map<string, MarketCtx>,
    collateral: PublicKey,
    musd: bigint,
    bal: (m: PublicKey, o: PublicKey) => bigint,
    has: (k: PublicKey) => boolean,
    dtMs: number,
    nowMs: number,
  ) {
    const p = t.profile;
    const me = t.keypair.publicKey;
    const maker = me.toBase58();
    const mine = lives.filter((l) => l.featured && l.snap.tradingOpen && p.hazards.includes(l.entry.hazard));
    // Expired limit orders are cancelled whether or not the trader acts (rent returns to it).
    for (const l of mine) {
      const ctx = ctxs.get(l.snap.market.address.toBase58());
      if (!ctx) continue;
      const own = l.snap.orders.filter((o) => o.maker === maker && o.remainingQty > 0n);
      const old = staleOrders({ p, ctx, h: { musd, yes: 0n, no: 0n, own } });
      if (old.length) return () => this.cancel(t, l.snap, collateral, old, "lifetime over");
    }
    const pAct = 1 - Math.exp((-p.ratePerMin * this.o.rate * this.rateMult * dtMs) / 60_000);
    if (!mine.length || !this.rng.chance(pAct)) return undefined;
    const l = this.rng.pick(mine);
    const m = l.snap.market;
    const mk = m.address.toBase58();
    const ctx = ctxs.get(mk);
    if (!ctx) return undefined;
    const h: Holdings = {
      musd,
      yes: bal(m.yesMint, me),
      no: bal(m.noMint, me),
      own: l.snap.orders.filter((o) => o.maker === maker && o.remainingQty > 0n),
    };
    const mem = t.memory.get(mk) ?? {};
    const action = decide({ p, me: maker, ctx, h, mem, rng: this.rng, nowMs });
    if (!action) return undefined;
    return () => this.execute(t, l.snap, collateral, action, has);
  }

  /** ATA creations paid by the sponsor, only for accounts that do not exist yet (§4). */
  private atas(owner: PublicKey, mints: PublicKey[], has: (k: PublicKey) => boolean): TransactionInstruction[] {
    const uniq = [...new Map(mints.map((m) => [m.toBase58(), m])).values()];
    return uniq
      .filter((mint) => !has(ataOf(mint, owner)))
      .map((mint) => createAssociatedTokenAccountIdempotentInstruction(this.o.sponsor.publicKey, ataOf(mint, owner), owner, mint, TOKEN_PROGRAM_ID));
  }

  private async takeIxs(snap: MarketBookSnapshot, me: PublicKey, collateral: PublicKey, a: { outcome: OutcomeCode; side: 0 | 1; qty: bigint; worstPriceBps: number }) {
    const plan = planMarketOrder(snap.book, { outcome: a.outcome, side: a.side, qty: a.qty, worstPriceBps: a.worstPriceBps, taker: me.toBase58() });
    const ixs: TransactionInstruction[] = [];
    let i = 0;
    for (const f of plan.fills) {
      const o = snap.book.find((x) => x.id === f.orderId);
      if (!o) continue;
      ixs.push(await takeOrderIx(this.program, snap.market, me, collateral, asOrder(o), f.qty, a.worstPriceBps));
      i++;
    }
    return { ixs, fills: plan.fills.slice(0, i) };
  }

  private async execute(t: SimTrader, snap: MarketBookSnapshot, collateral: PublicKey, a: SimAction, has: (k: PublicKey) => boolean): Promise<void> {
    const me = t.keypair.publicKey;
    const m = snap.market;
    const prog = this.program;
    switch (a.kind) {
      case "cancel":
        return this.cancel(t, snap, collateral, a.orders, a.reason);
      case "take": {
        const { ixs, fills } = await this.takeIxs(snap, me, collateral, a);
        if (!ixs.length) return;
        const receive = a.side === OrderSide.Buy ? (a.outcome === Outcome.Yes ? m.yesMint : m.noMint) : collateral;
        let take = ixs;
        let used = fills;
        const pre = this.atas(me, [receive], has);
        while (take.length > 1 && !fits([...pre, ...take], this.o.sponsor.publicKey, 2)) {
          take = take.slice(0, -1);
          used = used.slice(0, -1);
        }
        const qty = used.reduce((s, f) => s + f.qty, 0n);
        const quote = used.reduce((s, f) => s + f.quote, 0n);
        const ok = await this.send(t, snap, [...pre, ...take], `${a.reason}: ${a.side === 0 ? "buy" : "sell"} ${qty} ${a.outcome === 0 ? "YES" : "NO"} over ${used.length} level(s)`, used.length, quote);
        if (ok && qty > 0n) {
          const avg = Number((quote * 1_000n) / (qty * 100n)) / 1_000;
          t.memory.set(m.address.toBase58(), remember(t.memory.get(m.address.toBase58()) ?? {}, a, avg, Date.now()));
        }
        return;
      }
      case "limit": {
        if (!t.profile.postsLimits) return;
        const o = { outcome: a.outcome, side: a.side };
        const pre = this.atas(me, [escrowMintOf(o, m, collateral), receiveMintOf(o, m, collateral)], has);
        const placed = await placeOrderIx(prog, m, me, collateral, {
          clientNonce: randomNonce(),
          outcome: a.outcome,
          side: a.side,
          priceBps: a.priceBps,
          quantity: a.qty,
          expiresAt: snap.now + BigInt(a.ttlS + 60),
        });
        await this.send(t, snap, [...pre, placed.ix], `${a.reason}: ${a.qty} ${a.outcome === 0 ? "YES" : "NO"} @ ${a.priceBps}`);
        return;
      }
      case "buyMerge": {
        const y = await this.takeIxs(snap, me, collateral, { outcome: Outcome.Yes, side: OrderSide.Buy, qty: a.qty, worstPriceBps: a.yesWorstBps });
        const n = await this.takeIxs(snap, me, collateral, { outcome: Outcome.No, side: OrderSide.Buy, qty: a.qty, worstPriceBps: a.noWorstBps });
        const qy = y.fills.reduce((s, f) => s + f.qty, 0n);
        const qn = n.fills.reduce((s, f) => s + f.qty, 0n);
        const q = qy < qn ? qy : qn;
        if (q === 0n || y.ixs.length !== 1 || n.ixs.length !== 1) return;
        const pre = this.atas(me, [m.yesMint, m.noMint], has);
        const quote = [...y.fills, ...n.fills].reduce((s, f) => s + f.quote, 0n);
        await this.send(t, snap, [...pre, ...y.ixs, ...n.ixs, await mergeIx(prog, m, me, collateral, q)], `${a.reason}: buy ${q} YES + NO, merge`, 2, quote);
        return;
      }
      case "splitSell": {
        const y = await this.takeIxs(snap, me, collateral, { outcome: Outcome.Yes, side: OrderSide.Sell, qty: a.qty, worstPriceBps: a.yesWorstBps });
        const n = await this.takeIxs(snap, me, collateral, { outcome: Outcome.No, side: OrderSide.Sell, qty: a.qty, worstPriceBps: a.noWorstBps });
        if (y.ixs.length !== 1 || n.ixs.length !== 1) return;
        const pre = this.atas(me, [m.yesMint, m.noMint], has);
        const quote = [...y.fills, ...n.fills].reduce((s, f) => s + f.quote, 0n);
        await this.send(t, snap, [...pre, await splitIx(prog, m, me, collateral, a.qty), ...y.ixs, ...n.ixs], `${a.reason}: split ${a.qty}, sell both`, 2, quote);
        return;
      }
    }
  }

  private async cancel(t: SimTrader, snap: MarketBookSnapshot, collateral: PublicKey, orders: OrderAccount[], reason: string): Promise<void> {
    const me = t.keypair.publicKey;
    for (let i = 0; i < orders.length; i += 4) {
      const ixs = await Promise.all(orders.slice(i, i + 4).map((o) => cancelOrderIx(this.program, snap.market, me, collateral, o)));
      if (!(await this.send(t, snap, ixs, `cancel ${ixs.length} (${reason})`))) return;
    }
  }

  /** One transaction: sponsor pays the fee, the trader signs as owner. True when confirmed. */
  private async send(t: SimTrader, snap: MarketBookSnapshot, ixs: Array<TransactionInstruction | Promise<TransactionInstruction>>, what: string, fills = 0, quote = 0n): Promise<boolean> {
    if (isClosureHeld(snap.market.round)) return false;
    try {
      const sig = await sendExchangeTx(this.o.rpc.connection, await Promise.all(ixs), [this.o.sponsor, t.keypair]);
      this.sent++;
      this.fillsSubmitted += fills;
      this.volume += quote;
      if (fills) this.recentFills.push({ t: Date.now(), n: fills });
      this.rateMult = Math.min(1, this.rateMult + 0.02);
      this.lastError = null;
      this.log(`[sim ${t.profile.id} ${t.profile.archetype}] ${what} on ${snap.market.address.toBase58().slice(0, 6)} ${explorerTx(sig)}`);
      return true;
    } catch (e) {
      this.fail(t, e, what);
      return false;
    }
  }

  private fail(t: SimTrader, e: unknown, what = "action"): void {
    const raw = e instanceof Error ? e.message : typeof e === "string" ? e : undefined;
    let msg = raw ?? String(e);
    if (msg === "[object Object]") {
      try {
        msg = JSON.stringify(e, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 300);
      } catch {
        msg = "unknown error";
      }
    }
    this.failed++;
    this.lastError = msg;
    // Back off this trader, and the whole population on RPC pressure (AIMD, §5).
    this.cooldownUntil.set(t.profile.id, Date.now() + 10_000);
    if (/429|Too Many|timeout|fetch failed|ECONN|blockhash/i.test(msg)) this.rateMult = Math.max(0.1, this.rateMult * 0.7);
    this.log(`[sim ${t.profile.id}] ${what} failed: ${msg}`);
  }

  private beat(status: Record<string, string | number | boolean | null>): void {
    if (this.o.heartbeat === false) return;
    try {
      writeHeartbeat("sim", { ...status, ticks: this.ticks, sent: this.sent, failed: this.failed, lastError: this.lastError });
    } catch (e) {
      this.log(`[sim] heartbeat write failed: ${(e as Error).message}`);
    }
  }
}
