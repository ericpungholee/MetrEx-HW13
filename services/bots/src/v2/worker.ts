// v2 bot worker (spec-v2 §8): thin I/O around the pure planner in strategy.ts. Reuses the v1 shell's
// pattern (poll, idempotency via cooldowns, SOL checks, logging). Imports only the oracle-free
// "@metrex/server/exchange" entry (§8.4).

import { PublicKey, Transaction, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import {
  Outcome,
  OrderSide,
  adaptiveParams,
  anchorLadder,
  catalogByProperty,
  homeMarket,
  isHomeProperty,
  isListing,
  makerCapitalFor,
  openingBidBps,
  type CatalogMarket,
  diffFills,
  findOrderPda,
  initAdaptive,
  randomNonce,
  restingMid,
  stepAdaptive,
  DEFAULT_ADAPTIVE,
  type AdaptiveConfig,
  type AdaptiveState,
  type BotParams,
  type BookOrder,
  type OrderAccount,
  type Quote,
} from "@metrex/exchange";
import {
  ataOf,
  cancelOrderIx,
  explorerTx,
  getExchangeProgram,
  ExchangeStateLoader,
  mergeIx,
  placeOrderIx,
  redeemIx,
  sendExchangeTx,
  splitIx,
  tokenAmountOf,
  writeHeartbeat,
  type ExchangeProgram,
  type MarketBookSnapshot,
  type MarketView,
  type RpcPool,
  fullResetHeld,
  MAKER_CAPITAL,
  isClosureHeld,
  readHeartbeat,
} from "@metrex/server/exchange";
import { applyToSnapshot, collateralSpend, committedCapital, planBotMarket, type BotAction, type BotConfig, type MarketPhase } from "./strategy";

export interface V2Bot {
  params: BotParams;
  keypair: Keypair;
  /** market → ms of the last confirmed action (requote cooldown and RPC catch-up). */
  lastAction: Map<string, number>;
}

export interface V2WorkerOptions {
  rpc: RpcPool;
  bots: V2Bot[];
  config: BotConfig;
  featuredPropertyId: number;
  /** Rounds to look back for cleanup and redemption (latest included). */
  roundsBack?: number;
  legacyRehearsal?: boolean;
  heartbeat?: boolean;
  log?: (line: string) => void;
  /** Adaptive references on catalog markets (docs/spec-simulation.md §3). Default on. */
  adaptive?: boolean;
  adaptiveConfig?: AdaptiveConfig;
}

/** Solana's packet limit for a serialized transaction. */
const MAX_TX_BYTES = 1232;

/** Whether `ixs` fit one transaction signed by `payer` alone. */
export function fitsOneTransaction(ixs: TransactionInstruction[], payer: PublicKey): boolean {
  try {
    const tx = new Transaction({ feePayer: payer, recentBlockhash: PublicKey.default.toBase58() }).add(...ixs);
    return tx.serializeMessage().length + 1 + 64 <= MAX_TX_BYTES;
  } catch {
    return false;
  }
}

/** Skip a bot below this SOL balance (§8.1 balance checks). */
export const MIN_SOL_LAMPORTS = 10_000_000n;

type Row = BookOrder & { isBot: boolean };

export function phaseOf(s: Pick<MarketBookSnapshot, "market" | "tradingOpen">): MarketPhase {
  switch (s.market.outcome) {
    case "yes":
      return "resolved_yes";
    case "no":
      return "resolved_no";
    case "invalid":
      return "resolved_invalid";
    default:
      return s.tradingOpen ? "trading" : "closed";
  }
}

/** Balances read in the tick's batched load. */
interface Balances {
  sol: (bot: V2Bot) => bigint;
  token: (mint: PublicKey, owner: PublicKey) => bigint;
}

interface Planned {
  bot: V2Bot;
  market: MarketView;
  action: BotAction;
  /** For requotes: the client nonce chosen at planning time. */
  nonce?: bigint;
}

export class ExchangeBotWorker {
  private readonly log: (line: string) => void;
  private collateral: PublicKey | undefined;
  private ticks = 0;
  private sent = 0;
  private failed = 0;
  private lastError: string | null = null;
  private readonly loader = new ExchangeStateLoader();
  /** bot:market groups with transactions in flight, and when each group last settled. */
  private readonly busy = new Map<string, Promise<void>>();
  private readonly settledAt = new Map<string, number>();
  private readonly reserved = new Map<string, { bot: V2Bot; amount: bigint }>();
  private thinBooks = "";
  /** Adaptive pricing per catalog market: the previous order read and the current state. */
  private readonly prevOrders = new Map<string, OrderAccount[]>();
  private readonly pricers = new Map<string, AdaptiveState>();
  /** Homeowner markets: the opening-bid anchor, fixed once seen (docs/spec-multiperil.md §7.7). */
  private readonly homeAnchors = new Map<string, number>();

  constructor(private readonly o: V2WorkerOptions) {
    this.log = o.log ?? ((l) => console.log(`${new Date().toISOString()} ${l}`));
  }

  private get program(): ExchangeProgram {
    return getExchangeProgram(this.o.rpc.connection);
  }

  async tick(): Promise<void> {
    this.ticks++;
    // An operator Reset Demo signs for the makers itself (docs/spec-simulation.md §9): stand aside.
    if (fullResetHeld()) {
      await this.drain();
      this.beat({ state: "reset_hold", inFlight: 0 });
      return;
    }
    const rpc = this.o.rpc;
    const loadStarted = Date.now();
    // One batched read per tick: every book of the recent rounds plus each bot's SOL, mUSD, YES and
    // NO balances, in a fixed handful of RPC calls however many markets exist.
    const state = await rpc.run((c) =>
      this.loader.load(c, {
        roundsBack: this.o.roundsBack,
        extraKeys: (markets, config) =>
          this.o.bots.flatMap((b) => {
            const me = b.keypair.publicKey;
            return [me, ataOf(config.collateralMint, me), ...markets.flatMap((m) => [ataOf(m.yesMint, me), ataOf(m.noMint, me)])];
          }),
      }),
    );
    if (!state) {
      this.beat({ state: "waiting_for_config" });
      return;
    }
    const config = state.config;
    this.collateral = config.collateralMint;
    const botKeys = new Set(this.o.bots.map((b) => b.keypair.publicKey.toBase58()));
    const balances: Balances = {
      sol: (b) => BigInt(state.extra.get(b.keypair.publicKey.toBase58())?.lamports ?? 0),
      token: (mint, owner) => tokenAmountOf(state.extra.get(ataOf(mint, owner).toBase58())),
    };

    const keeper = readHeartbeat("keeper");
    const keeperSweeps = keeper.alive && keeper.heartbeat?.status.matching === true;
    const liquid = new Map(this.o.bots.map((b) => [b, balances.token(config.collateralMint, b.keypair.publicKey)]));
    for (const [key, { bot, amount }] of this.reserved) {
      if (!this.busy.has(key) && (this.settledAt.get(key) ?? 0) < loadStarted) {
        this.reserved.delete(key);
      } else {
        liquid.set(bot, liquid.get(bot)! - amount);
      }
    }
    const capitalStatus: Record<string, string> = {};
    const thinBooks: string[] = [];
    const planned: Planned[] = [];
    for (const snap of state.snapshots) {
      const m = snap.market;
      if (isClosureHeld(snap.round.address)) continue;
      const entry = this.entryOf(snap, botKeys);
      if (snap.tradingOpen && !entry && !this.o.legacyRehearsal) continue;
      if (!snap.tradingOpen && snap.orders.length && keeperSweeps) continue;
      // Skew is off on every catalog market (one featured market per hazard, docs/spec-multiperil.md §6)
      // and on the legacy featured property of the latest round (spec-v2 §8.3).
      const featured =
        entry !== undefined ||
        (m.propertyId === this.o.featuredPropertyId && m.round.equals(config.latestRound));
      if (snap.tradingOpen) {
        const depth = (outcome: number, side: number) => snap.book
          .filter((o) => o.outcome === outcome && o.side === side)
          .reduce((sum, o) => sum + o.remaining, 0n);
        const hazard = entry?.hazard;
        const listing = isListing(m.propertyId) || isHomeProperty(m.propertyId);
        const key = hazard ? (listing ? `${hazard}_${m.propertyId}` : hazard) : m.address.toBase58();
        const sizes = [
          depth(Outcome.Yes, OrderSide.Buy), depth(Outcome.Yes, OrderSide.Sell),
          depth(Outcome.No, OrderSide.Buy), depth(Outcome.No, OrderSide.Sell),
        ];
        capitalStatus[`depth_${key}`] = sizes.join("/");
        if ((!listing && sizes[1]! < 25_000n) || sizes.some((q) => q === 0n)) thinBooks.push(key);
      }
      // The post-only clamp needs opposing orders that are still being discovered by the loader.
      if (snap.tradingOpen && state.orderDiscoveryPending.has(m.address.toBase58())) continue;
      planned.push(...this.planMarket(snap, featured, botKeys, balances, liquid, loadStarted, capitalStatus, this.updatePricer(snap, entry), entry));
    }
    // Group by bot and market: a split goes out together with the asks it funds (see executeGroup).
    const groups = new Map<string, Planned[]>();
    for (const p of planned) {
      const k = `${p.bot.params.name}:${p.market.address.toBase58()}`;
      groups.set(k, [...(groups.get(k) ?? []), p]);
    }
    // Groups run in the background so a slow one (cleanup of an old round waiting on Devnet
    // confirmations) never delays quoting a new market. A group is skipped while it is in flight,
    // and until a read that started after it settled, so it is never planned from stale state.
    let launched = 0;
    for (const [k, g] of groups) {
      launched++;
      const amount = collateralSpend(g.map((p) => p.action));
      if (amount > 0n) this.reserved.set(k, { bot: g[0]!.bot, amount });
      const run = this.executeGroup(g)
        .catch((e: unknown) => {
          this.failed++;
          this.lastError = (e as Error).message;
        })
        .finally(() => {
          this.busy.delete(k);
          this.settledAt.set(k, Date.now());
        });
      this.busy.set(k, run);
    }
    const thin = thinBooks.join(", ");
    if (thin !== this.thinBooks) {
      this.log(thin ? `[bots] low executable depth: ${thin}` : "[bots] executable depth recovered");
      this.thinBooks = thin;
    }
    this.beat({
      state: "running",
      markets: state.snapshots.length,
      planned: planned.length,
      launched,
      inFlight: this.busy.size,
      rpcRequests: rpc.pacer.total,
      thinBooks: thin,
      ...Object.fromEntries(this.o.bots.map((b) => [`free_${b.params.name}`, balances.token(config.collateralMint, b.keypair.publicKey).toString()])),
      ...capitalStatus,
      ...Object.fromEntries([...this.pricers].map(([k, p]) => [`mid_${k.slice(0, 6)}`, Math.round(p.publishedBps * 100) / 100])),
    });
  }

  /**
   * Adaptive reference of a trading catalog market (docs/spec-simulation.md §3): fills are the
   * `remaining_qty` decreases since the previous read. Starts from maker A's resting mid after a
   * restart, else from the catalog.
   */
  private updatePricer(snap: MarketBookSnapshot, entry: CatalogMarket | undefined): AdaptiveState | undefined {
    if (this.o.adaptive === false || !entry || !snap.tradingOpen) return undefined;
    const mk = snap.market.address.toBase58();
    const now = Date.now();
    const a = entry.ladder[0];
    if (!a) return undefined;
    const botA = this.o.bots.find((b) => b.params.name === a.name)?.keypair.publicKey.toBase58();
    let s = this.pricers.get(mk) ?? initAdaptive(a.refBps, now, botA ? restingMid(snap.orders, botA) : undefined);
    const prev = this.prevOrders.get(mk);
    if (prev) {
      const fills = diffFills(prev, snap.orders);
      s = stepAdaptive(s, fills, now, a.topSize, this.o.adaptiveConfig ?? DEFAULT_ADAPTIVE);
      if (fills.length) this.log(`[bots] ${mk.slice(0, 6)} ${fills.length} fills observed, mid ${s.midBps.toFixed(2)} (quoting ${s.publishedBps.toFixed(2)}) bps`);
    }
    this.prevOrders.set(mk, snap.orders);
    this.pricers.set(mk, s);
    return s;
  }

  /**
   * Maker entry for one market: its catalog or listing entry, or for a homeowner market
   * (docs/spec-multiperil.md §7.7) the hazard's ladder re-centred on the homeowner's opening YES bid.
   * A homeowner market is not quoted until that bid exists. After a restart the bid may be gone, and
   * maker A's own resting mid keeps the anchor. Undefined means the makers stay out.
   */
  private entryOf(snap: MarketBookSnapshot, botKeys: Set<string>): CatalogMarket | undefined {
    const m = snap.market;
    const fixed = catalogByProperty(m.propertyId);
    if (fixed || !isHomeProperty(m.propertyId)) return fixed;
    const base = homeMarket(m.propertyId, m.scenarioId, `Property ${m.propertyId}`);
    if (!base) return undefined;
    const mk = m.address.toBase58();
    let anchor = this.homeAnchors.get(mk);
    if (anchor === undefined) {
      anchor = openingBidBps(snap.book, (k) => botKeys.has(k));
      const a = base.ladder[0];
      const botA = a ? this.o.bots.find((b) => b.params.name === a.name)?.keypair.publicKey.toBase58() : undefined;
      if (anchor === undefined && botA) {
        const mid = restingMid(snap.orders, botA);
        if (mid !== undefined) anchor = Math.round(mid);
      }
      if (anchor === undefined) return undefined;
      this.homeAnchors.set(mk, anchor);
      this.log(`[bots] homeowner market ${mk.slice(0, 6)}: quoting around the opening bid ${anchor} bps`);
    }
    return { ...base, ladder: anchorLadder(base.ladder, anchor) };
  }

  /** Waits for every in-flight group (shutdown). */
  async drain(): Promise<void> {
    while (this.busy.size) await Promise.all([...this.busy.values()]);
  }

  private planMarket(
    snap: MarketBookSnapshot, featured: boolean, botKeys: Set<string>, bal: Balances, liquid: Map<V2Bot, bigint>,
    loadStarted: number, capitalStatus: Record<string, string>, pricer?: AdaptiveState, entry?: CatalogMarket,
  ): Planned[] {
    const phase = phaseOf(snap);
    const m = snap.market;
    const mk = m.address.toBase58();
    const now = Date.now();
    let rows: Row[] = snap.book.map((o) => ({ ...o, isBot: botKeys.has(o.maker) }));
    let seq = snap.market.nextOrderSeq + 1_000_000n; // placeholder seqs for planned orders: younger than any real one
    const out: Planned[] = [];
    for (const bot of this.o.bots) {
      const me = bot.keypair.publicKey;
      const maker = me.toBase58();
      const own = snap.orders.filter((o) => o.maker === maker);
      const budget = liquid.get(bot) ?? 0n;
      const yes = bal.token(m.yesMint, me);
      const no = bal.token(m.noMint, me);
      const key = `${bot.params.name}:${mk}`;
      const balances = { musd: budget > 0n ? budget : 0n, yes, no };
      // Featured markets share four fifths of a maker's capital and listings the rest (spec-multiperil §7.7).
      const marketCapital = makerCapitalFor(m.propertyId, MAKER_CAPITAL);
      if (snap.tradingOpen && entry) {
        const tag = isListing(m.propertyId) || isHomeProperty(m.propertyId) ? `${entry.hazard}_${m.propertyId}` : entry.hazard;
        capitalStatus[`committed_${bot.params.name}_${tag}`] = committedCapital(balances, own).toString();
      }
      if (this.busy.has(key) || (this.settledAt.get(key) ?? 0) >= loadStarted) continue;
      if (phase !== "trading" && own.length === 0 && yes === 0n && no === 0n) continue;
      if (bal.sol(bot) < MIN_SOL_LAMPORTS) {
        this.log(`[bot ${bot.params.name}] skip ${mk}: SOL below 0.01`);
        continue;
      }
      const last = bot.lastAction.get(mk);
      if (last !== undefined && now - last < this.o.config.cooldownMs) continue; // RPC catch-up and cooldown
      // Per-market starting quotes and split size (docs/spec-multiperil.md §6); legacy ladder otherwise.
      const base = entry?.ladder.find((p) => p.name === bot.params.name) ?? bot.params;
      const refA = entry?.ladder[0]?.refBps;
      // Adaptive markets quote around the moving mid with inventory skew on (docs/spec-simulation.md §3).
      const params = pricer && refA ? adaptiveParams(base, refA, pricer, this.o.adaptiveConfig ?? DEFAULT_ADAPTIVE) : base;
      const actions = planBotMarket({
        params,
        config: entry ? { ...this.o.config, splitPairs: entry.splitPairs } : this.o.config,
        maker,
        phase,
        featured: pricer ? false : featured,
        strictPostOnly: !this.o.legacyRehearsal,
        balances,
        marketCapital,
        own,
        others: rows.filter((r) => r.maker !== maker),
        nowMs: now,
        lastRequoteMs: last,
      });
      liquid.set(bot, budget - collateralSpend(actions));
      const cancelled: string[] = [];
      const placed: { id: string; quote: Quote }[] = [];
      for (const action of actions) {
        const p: Planned = { bot, market: m, action };
        if (action.kind === "requote") {
          if (action.cancel) cancelled.push(action.cancel.address);
          if (action.place) {
            p.nonce = randomNonce();
            placed.push({ id: findOrderPda(this.program.programId, m.address, me, p.nonce)[0].toBase58(), quote: action.place });
          }
        }
        out.push(p);
      }
      // The next bot in this tick sees this bot's planned book (sequential post-only, §8.2).
      rows = applyToSnapshot(rows, maker, cancelled, placed, seq);
      seq += BigInt(placed.length);
    }
    return out;
  }

  /** Batch a market's requotes when they fit to save send and confirmation RPC calls. */
  private async executeGroup(g: Planned[]): Promise<void> {
    const first = g[0]!;
    if (g.length === 1 || first.action.kind === "cancel") {
      await this.execute(first);
      return;
    }
    const parts = await Promise.all(g.map((p) => this.instructionsFor(p)));
    const ixs = parts.flatMap((part) => part.ixs);
    if (fitsOneTransaction(ixs, first.bot.keypair.publicKey)) {
      await this.send(first, ixs, parts.map((part) => part.what).join(" + "), parts.flatMap((part) => part.orders));
      return;
    }
    // If the packet is too large, a split must confirm before any ask can use the new shares.
    if (first.action.kind === "split" && !(await this.execute(first))) return;
    await Promise.all((first.action.kind === "split" ? g.slice(1) : g).map((p) => this.execute(p)));
  }

  private async instructionsFor(p: Planned): Promise<{ ixs: TransactionInstruction[]; what: string; orders: PublicKey[] }> {
    const { bot, market: m, action: a } = p;
    const me = bot.keypair.publicKey;
    const collateral = this.collateral as PublicKey;
    const prog = this.program;
    switch (a.kind) {
      case "split":
        return { ixs: [await splitIx(prog, m, me, collateral, a.quantity)], what: `split ${a.quantity}`, orders: [] };
      case "merge":
        return { ixs: [await mergeIx(prog, m, me, collateral, a.quantity)], what: `merge ${a.quantity}`, orders: [] };
      case "redeem":
        return { ixs: [await redeemIx(prog, m, me, collateral, a.outcome, a.quantity)], what: `redeem ${a.outcome === 0 ? "YES" : "NO"} ${a.quantity}`, orders: [] };
      case "requote": {
        const ixs: TransactionInstruction[] = [];
        const orders: PublicKey[] = [];
        if (a.cancel) ixs.push(await cancelOrderIx(prog, m, me, collateral, a.cancel));
        if (a.place && p.nonce !== undefined) {
          const q = a.place;
          const placed = await placeOrderIx(prog, m, me, collateral, { clientNonce: p.nonce, outcome: q.outcome, side: q.side, priceBps: q.priceBps, quantity: q.size });
          ixs.push(placed.ix);
          orders.push(placed.order);
        }
        const side = a.place ?? a.cancel;
        const what = `${a.reason} ${side ? `${side.outcome === 0 ? "YES" : "NO"} ${side.side === 0 ? "BUY" : "SELL"}` : ""}${a.cancel ? ` ✕${a.cancel.priceBps}` : ""}${a.place ? ` → ${a.place.size}@${a.place.priceBps}` : ""}`;
        return { ixs, what, orders };
      }
      case "cancel":
        throw new Error("cancel actions are sent in batches by execute()");
    }
  }

  /** Sends one transaction for `p`'s bot and market; true when it confirmed. Placed orders are read from the next load. */
  private async send(p: Planned, ixs: TransactionInstruction[], what: string, orders: PublicKey[] = []): Promise<boolean> {
    const mk = p.market.address.toBase58();
    const id = `[bot ${p.bot.params.name}]`;
    try {
      if (isClosureHeld(p.market.round)) return false;
      const sig = await sendExchangeTx(this.o.rpc.connection, ixs, [p.bot.keypair]);
      this.sent++;
      if (orders.length) this.loader.addKnownOrders(p.market.address, orders);
      p.bot.lastAction.set(mk, Date.now());
      this.lastError = null;
      this.log(`${id} ${what} on ${mk} ${explorerTx(sig)}`);
      return true;
    } catch (e) {
      this.failed++;
      this.lastError = (e as Error).message;
      p.bot.lastAction.set(mk, Date.now()); // back off one cooldown, then re-plan from fresh chain state
      this.log(`${id} ${p.action.kind} on ${mk} failed: ${(e as Error).message}`);
      return false;
    }
  }

  private async execute(p: Planned): Promise<boolean> {
    const { bot, market: m, action: a } = p;
    if (a.kind !== "cancel") {
      try {
        const { ixs, what, orders } = await this.instructionsFor(p);
        return await this.send(p, ixs, what, orders);
      } catch (e) {
        this.failed++;
        this.lastError = (e as Error).message;
        this.log(`[bot ${bot.params.name}] ${a.kind} on ${m.address.toBase58()} failed: ${(e as Error).message}`);
        return false;
      }
    }
    const me = bot.keypair.publicKey;
    const collateral = this.collateral as PublicKey;
    const prog = this.program;
    const mk = m.address.toBase58();
    const id = `[bot ${bot.params.name}]`;
    try {
      for (let i = 0; i < a.orders.length; i += 4) {
        const batch = await Promise.all(a.orders.slice(i, i + 4).map((o) => cancelOrderIx(prog, m, me, collateral, o)));
        if (isClosureHeld(m.round)) return false;
        const sig = await sendExchangeTx(this.o.rpc.connection, batch, [bot.keypair]);
        this.sent++;
        this.log(`${id} cancel ${batch.length} on ${mk} (${a.reason}) ${explorerTx(sig)}`);
      }
      bot.lastAction.set(mk, Date.now());
      return true;
    } catch (e) {
      this.failed++;
      this.lastError = (e as Error).message;
      bot.lastAction.set(mk, Date.now());
      this.log(`${id} cancel on ${mk} failed: ${(e as Error).message}`);
      return false;
    }
  }

  private beat(status: Record<string, string | number | boolean | null>): void {
    if (this.o.heartbeat === false) return;
    try {
      writeHeartbeat("bots", { ...status, ticks: this.ticks, sent: this.sent, failed: this.failed, lastError: this.lastError });
    } catch (e) {
      this.log(`[bots] heartbeat write failed: ${(e as Error).message}`);
    }
  }
}
