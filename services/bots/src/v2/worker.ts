// v2 bot worker (spec-v2 §8): thin I/O around the pure planner in strategy.ts. Reuses the v1 shell's
// pattern (poll, idempotency via cooldowns, SOL checks, logging). Imports only the oracle-free
// "@metrex/server/exchange" entry (§8.4).

import { PublicKey, Transaction, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import {
  OrderSide,
  catalogByProperty,
  catalogByScenario,
  findOrderPda,
  ladderFor,
  randomNonce,
  type BotParams,
  type BookOrder,
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
} from "@metrex/server/exchange";
import { applyToSnapshot, planBotMarket, type BotAction, type BotConfig, type MarketPhase } from "./strategy";

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
  heartbeat?: boolean;
  log?: (line: string) => void;
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

  constructor(private readonly o: V2WorkerOptions) {
    this.log = o.log ?? ((l) => console.log(`${new Date().toISOString()} ${l}`));
  }

  private get program(): ExchangeProgram {
    return getExchangeProgram(this.o.rpc.connection);
  }

  async tick(): Promise<void> {
    this.ticks++;
    const rpc = this.o.rpc;
    const loadStarted = Date.now();
    // One batched read per tick: every book of the recent rounds plus each bot's SOL, mUSD, YES and
    // NO balances, in a fixed handful of RPC calls however many markets exist.
    const state = await rpc.run((c) =>
      this.loader.load(c, {
        // Multi-peril: one Open round per hazard, so look further back than the single-round design.
        roundsBack: this.o.roundsBack ?? 8,
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

    const planned: Planned[] = [];
    for (const snap of state.snapshots) {
      const m = snap.market;
      // The post-only clamp needs opposing orders that are still being discovered by the loader.
      if (snap.tradingOpen && state.orderDiscoveryPending.has(m.address.toBase58())) continue;
      // Skew is off on every catalog market (one featured market per hazard, docs/spec-multiperil.md §6)
      // and on the legacy featured property of the latest round (spec-v2 §8.3).
      const featured =
        catalogByProperty(m.propertyId) !== undefined ||
        (m.propertyId === this.o.featuredPropertyId && m.round.equals(config.latestRound));
      planned.push(...this.planMarket(snap, featured, botKeys, balances));
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
      if (this.busy.has(k) || (this.settledAt.get(k) ?? 0) >= loadStarted) continue;
      launched++;
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
    this.beat({
      state: "running",
      markets: state.snapshots.length,
      planned: planned.length,
      launched,
      inFlight: this.busy.size,
      rpcRequests: rpc.pacer.total,
    });
  }

  /** Waits for every in-flight group (shutdown). */
  async drain(): Promise<void> {
    while (this.busy.size) await Promise.all([...this.busy.values()]);
  }

  private planMarket(snap: MarketBookSnapshot, featured: boolean, botKeys: Set<string>, bal: Balances): Planned[] {
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
      const musdBal = bal.token(this.collateral as PublicKey, me);
      const yes = bal.token(m.yesMint, me);
      const no = bal.token(m.noMint, me);
      if (phase !== "trading" && own.length === 0 && yes === 0n && no === 0n) continue;
      if (bal.sol(bot) < MIN_SOL_LAMPORTS) {
        this.log(`[bot ${bot.params.name}] skip ${mk}: SOL below 0.01`);
        continue;
      }
      const last = bot.lastAction.get(mk);
      if (last !== undefined && now - last < this.o.config.cooldownMs) continue; // RPC catch-up and cooldown
      // Per-market starting quotes and split size (docs/spec-multiperil.md §6); legacy ladder otherwise.
      const entry = catalogByProperty(m.propertyId) ?? catalogByScenario(m.scenarioId);
      const actions = planBotMarket({
        params: ladderFor(m.propertyId, m.scenarioId, bot.params.name, bot.params),
        config: entry ? { ...this.o.config, splitPairs: entry.splitPairs } : this.o.config,
        maker,
        phase,
        featured,
        balances: { musd: musdBal, yes, no },
        own,
        others: rows.filter((r) => r.maker !== maker),
        nowMs: now,
        lastRequoteMs: last,
      });
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

  /**
   * A split and the asks that escrow its new shares share one transaction when they fit (one
   * confirmation to enter a market instead of two). Bids only escrow mUSD, so they go in parallel.
   * If the bundle is too large, the split lands first and the asks follow it.
   */
  private async executeGroup(g: Planned[]): Promise<void> {
    const split = g.find((p) => p.action.kind === "split");
    if (!split) {
      await Promise.all(g.map((p) => this.execute(p)));
      return;
    }
    const isAsk = (p: Planned) => p.action.kind === "requote" && p.action.place?.side === OrderSide.Sell;
    const asks = g.filter(isAsk);
    const others = g.filter((p) => p !== split && !isAsk(p));
    const bundle = async () => {
      const parts = await Promise.all([split, ...asks].map((p) => this.instructionsFor(p)));
      const ixs = parts.flatMap((x) => x.ixs);
      if (asks.length && fitsOneTransaction(ixs, split.bot.keypair.publicKey)) {
        await this.send(split, ixs, parts.map((x) => x.what).join(" + "), parts.flatMap((x) => x.orders));
      } else {
        if (!(await this.execute(split))) return;
        for (const a of asks) await this.execute(a);
      }
    };
    await Promise.all([bundle(), ...others.map((p) => this.execute(p))]);
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
      const sig = await sendExchangeTx(this.o.rpc.connection, ixs, [p.bot.keypair]);
      this.sent++;
      if (orders.length) this.loader.addKnownOrders(p.market.address, orders);
      p.bot.lastAction.set(mk, Date.now());
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
