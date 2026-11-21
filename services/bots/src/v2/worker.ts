// v2 bot worker (spec-v2 §8): thin I/O around the pure planner in strategy.ts. Reuses the v1 shell's
// pattern (poll, idempotency via cooldowns, SOL checks, logging). Imports only the oracle-free
// "@metrex/server/exchange" entry (§8.4).

import { PublicKey, type Keypair, type TransactionInstruction } from "@solana/web3.js";
import { findOrderPda, randomNonce, type BotParams, type BookOrder, type Quote } from "@metrex/exchange";
import {
  ataOf,
  cancelOrderIx,
  explorerTx,
  fetchAllRounds,
  fetchExchangeConfig,
  fetchMarketsOfRound,
  getExchangeProgram,
  getSolLamports,
  loadMarketBook,
  mergeIx,
  placeOrderIx,
  redeemIx,
  sendExchangeTx,
  splitIx,
  tokenBalance,
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

  constructor(private readonly o: V2WorkerOptions) {
    this.log = o.log ?? ((l) => console.log(`${new Date().toISOString()} ${l}`));
  }

  private get program(): ExchangeProgram {
    return getExchangeProgram(this.o.rpc.connection);
  }

  async tick(): Promise<void> {
    this.ticks++;
    const rpc = this.o.rpc;
    const config = await rpc.run((c) => fetchExchangeConfig(getExchangeProgram(c)));
    if (!config) {
      this.beat({ state: "waiting_for_config" });
      return;
    }
    this.collateral = config.collateralMint;
    const rounds = (await rpc.run((c) => fetchAllRounds(getExchangeProgram(c)))).slice(-(this.o.roundsBack ?? 3));
    const markets = (await Promise.all(rounds.map((r) => rpc.run((c) => fetchMarketsOfRound(getExchangeProgram(c), r.address))))).flat();
    const botKeys = new Set(this.o.bots.map((b) => b.keypair.publicKey.toBase58()));
    const sol = new Map(
      await Promise.all(this.o.bots.map(async (b) => [b.params.name, await rpc.run((c) => getSolLamports(c, b.keypair.publicKey))] as const)),
    );

    const planned: Planned[] = [];
    for (const m of markets) {
      const snap = await rpc.run((c) => loadMarketBook(c, m.address, config.collateralMint));
      if (!snap) continue;
      const featured = m.propertyId === this.o.featuredPropertyId && m.round.equals(config.latestRound);
      planned.push(...(await this.planMarket(snap, featured, botKeys, sol)));
    }
    await Promise.all(planned.map((p) => this.execute(p)));
    this.beat({ state: "running", markets: markets.length, planned: planned.length });
  }

  private async planMarket(snap: MarketBookSnapshot, featured: boolean, botKeys: Set<string>, sol: Map<string, bigint>): Promise<Planned[]> {
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
      const [musdBal, yes, no] = await Promise.all([
        this.o.rpc.run((c) => tokenBalance(c, ataOf(this.collateral as PublicKey, me))),
        this.o.rpc.run((c) => tokenBalance(c, ataOf(m.yesMint, me))),
        this.o.rpc.run((c) => tokenBalance(c, ataOf(m.noMint, me))),
      ]);
      if (phase !== "trading" && own.length === 0 && yes === 0n && no === 0n) continue;
      if ((sol.get(bot.params.name) ?? 0n) < MIN_SOL_LAMPORTS) {
        this.log(`[bot ${bot.params.name}] skip ${mk}: SOL below 0.01`);
        continue;
      }
      const last = bot.lastAction.get(mk);
      if (last !== undefined && now - last < this.o.config.cooldownMs) continue; // RPC catch-up and cooldown
      const actions = planBotMarket({
        params: bot.params,
        config: this.o.config,
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

  private async execute(p: Planned): Promise<void> {
    const { bot, market: m, action: a } = p;
    const me = bot.keypair.publicKey;
    const collateral = this.collateral as PublicKey;
    const prog = this.program;
    const id = `[bot ${bot.params.name}]`;
    const mk = m.address.toBase58();
    const ixs: TransactionInstruction[] = [];
    let what = "";
    try {
      switch (a.kind) {
        case "split":
          ixs.push(await splitIx(prog, m, me, collateral, a.quantity));
          what = `split ${a.quantity}`;
          break;
        case "merge":
          ixs.push(await mergeIx(prog, m, me, collateral, a.quantity));
          what = `merge ${a.quantity}`;
          break;
        case "redeem":
          ixs.push(await redeemIx(prog, m, me, collateral, a.outcome, a.quantity));
          what = `redeem ${a.outcome === 0 ? "YES" : "NO"} ${a.quantity}`;
          break;
        case "cancel":
          for (let i = 0; i < a.orders.length; i += 4) {
            const batch = await Promise.all(a.orders.slice(i, i + 4).map((o) => cancelOrderIx(prog, m, me, collateral, o)));
            const sig = await sendExchangeTx(this.o.rpc.connection, batch, [bot.keypair]);
            this.sent++;
            this.log(`${id} cancel ${batch.length} on ${mk} (${a.reason}) ${explorerTx(sig)}`);
          }
          bot.lastAction.set(mk, Date.now());
          return;
        case "requote": {
          if (a.cancel) ixs.push(await cancelOrderIx(prog, m, me, collateral, a.cancel));
          if (a.place && p.nonce !== undefined) {
            const q = a.place;
            ixs.push((await placeOrderIx(prog, m, me, collateral, { clientNonce: p.nonce, outcome: q.outcome, side: q.side, priceBps: q.priceBps, quantity: q.size })).ix);
          }
          const side = a.place ?? a.cancel;
          what = `${a.reason} ${side ? `${side.outcome === 0 ? "YES" : "NO"} ${side.side === 0 ? "BUY" : "SELL"}` : ""}${a.cancel ? ` ✕${a.cancel.priceBps}` : ""}${a.place ? ` → ${a.place.size}@${a.place.priceBps}` : ""}`;
          break;
        }
      }
      const sig = await sendExchangeTx(this.o.rpc.connection, ixs, [bot.keypair]);
      this.sent++;
      bot.lastAction.set(mk, Date.now());
      this.log(`${id} ${what} on ${mk} ${explorerTx(sig)}`);
    } catch (e) {
      this.failed++;
      this.lastError = (e as Error).message;
      bot.lastAction.set(mk, Date.now()); // back off one cooldown, then re-plan from fresh chain state
      this.log(`${id} ${a.kind} on ${mk} failed: ${(e as Error).message}`);
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
