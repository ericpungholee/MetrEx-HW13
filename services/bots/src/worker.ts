// Thin I/O loop for the bots (spec §7): read chain state, call the pure planner, execute.

import { PublicKey, type Keypair } from "@solana/web3.js";
import { randomNonce, Side } from "@metrex/shared";
import {
  cancelListingIx,
  cancelOfferIx,
  configPda,
  explorerTx,
  fetchListings,
  fetchMarkets,
  fetchMarketsByKey,
  fetchOffers,
  filters,
  formatMusd,
  getMusdBalance,
  getProgram,
  getSolLamports,
  listPositionIx,
  placeOfferIx,
  sendTx,
  type MarketView,
  type MetrexProgram,
  type OfferView,
  type RpcPool,
} from "@metrex/server";
import type { BotParams } from "./params";
import { planTick, RequoteLimiter, type Action, type MarketLite, type OfferLite } from "./strategy";

export interface BotRuntime {
  params: BotParams;
  keypair: Keypair;
  /** market or offer key → expiry (ms): suppresses duplicate actions while RPC catches up. */
  inFlight: Map<string, number>;
  /** De-duplicates repeated skip logs: market → last reason. */
  lastSkip: Map<string, string>;
}

export interface WorkerOptions {
  rpc: RpcPool;
  mint: PublicKey;
  bots: BotRuntime[];
  tier2: boolean;
  listingPremiumPct: bigint;
  log?: (line: string) => void;
}

/** While a tx is being sent/confirmed. */
const IN_FLIGHT_MS = 60_000;
/** After confirmation, until getProgramAccounts reliably reflects it. */
const SETTLE_MS = 5_000;

export const toMarketLite = (m: MarketView): MarketLite => ({
  key: m.pubkey.toBase58(),
  homeowner: m.homeowner.toBase58(),
  status: m.status,
  coverageTarget: m.coverageTarget,
  coverageActivated: m.coverageActivated,
  createdAt: m.createdAt,
});

export const toOfferLite = (o: OfferView): OfferLite => ({
  key: o.pubkey.toBase58(),
  market: o.market.toBase58(),
  underwriter: o.underwriter.toBase58(),
  coverage: o.coverage,
  premiumBps: o.premiumBps,
  premium: o.premium,
  collateral: o.collateral,
  riskHolder: o.riskHolder.toBase58(),
  status: o.status,
});

export class BotWorker {
  readonly limiter = new RequoteLimiter();
  private readonly log: (line: string) => void;
  private configChecked = false;
  private configWaitLogged = false;

  constructor(private readonly o: WorkerOptions) {
    this.log = o.log ?? ((l) => console.log(`${new Date().toISOString()} ${l}`));
  }

  /** Verifies Config exists and its mint is ours. Returns false (and logs) if not ready. */
  private async checkConfig(program: MetrexProgram): Promise<boolean> {
    if (this.configChecked) return true;
    const config = await program.account.config.fetchNullable(configPda(program));
    if (!config) {
      if (!this.configWaitLogged) this.log("[bots] Config not initialized yet; waiting");
      this.configWaitLogged = true;
      return false;
    }
    if (!config.mint.equals(this.o.mint)) {
      throw new Error(`config.mint ${config.mint.toBase58()} != MUSD_MINT ${this.o.mint.toBase58()}`);
    }
    this.configChecked = true;
    return true;
  }

  async tick(): Promise<void> {
    const ready = await this.o.rpc.run((c) => this.checkConfig(getProgram(c)));
    if (!ready) return;
    const now = Date.now();
    for (const b of this.o.bots) for (const [k, exp] of b.inFlight) if (exp <= now) b.inFlight.delete(k);

    const openMarkets = await this.o.rpc.run((c) => fetchMarkets(getProgram(c), [filters.marketStatus("open")]));
    const openOffers = this.o.tier2
      ? await this.o.rpc.run((c) => fetchOffers(getProgram(c), [filters.offerStatus("open")]))
      : [];
    const botKeys = new Set(this.o.bots.map((b) => b.keypair.publicKey.toBase58()));
    await Promise.all(
      this.o.bots.map((b) =>
        this.tickBot(b, openMarkets, openOffers, botKeys).catch((e: unknown) =>
          this.log(`[bot ${b.params.id}] tick error: ${(e as Error).message}`),
        ),
      ),
    );
  }

  private async tickBot(
    b: BotRuntime,
    openMarketViews: MarketView[],
    openOfferViews: OfferView[],
    botKeys: Set<string>,
  ): Promise<void> {
    const me = b.keypair.publicKey;
    const meKey = me.toBase58();
    const rpc = this.o.rpc;
    const botOfferViews = await rpc.run((c) => fetchOffers(getProgram(c), [filters.offerUnderwriter(me)]));
    const markets = new Map<string, MarketLite>(openMarketViews.map((m) => [m.pubkey.toBase58(), toMarketLite(m)]));
    const missing = [...new Set(botOfferViews.map((o) => o.market.toBase58()))]
      .filter((k) => !markets.has(k))
      .map((k) => new PublicKey(k));
    if (missing.length) {
      const extra = await rpc.run((c) => fetchMarketsByKey(getProgram(c), missing));
      for (const [k, m] of extra) markets.set(k, toMarketLite(m));
    }
    const [solLamports, musd] = await Promise.all([
      rpc.run((c) => getSolLamports(c, me)),
      rpc.run((c) => getMusdBalance(c, me, this.o.mint)),
    ]);

    let riskListings = new Map<string, string>();
    if (this.o.tier2) {
      const listings = await rpc.run((c) => fetchListings(getProgram(c), [filters.listingSeller(me)]));
      riskListings = new Map(
        listings.filter((l) => l.side === Side.Risk).map((l) => [l.offer.toBase58(), l.pubkey.toBase58()]),
      );
    }

    const actions = planTick({
      params: b.params,
      bot: meKey,
      openMarkets: openMarketViews.map(toMarketLite),
      markets,
      botOffers: botOfferViews.map(toOfferLite),
      wallet: { musd, solLamports },
      inFlight: new Set(b.inFlight.keys()),
      tier2: this.o.tier2
        ? {
            openOffers: openOfferViews.map(toOfferLite),
            ignoreUnderwriters: new Set([...botKeys].filter((k) => k !== meKey)),
            limiter: this.limiter,
            riskListings,
            premiumPct: this.o.listingPremiumPct,
            now: Date.now(),
          }
        : undefined,
    });

    for (const a of actions) {
      try {
        await this.execute(b, a);
      } catch (e) {
        this.log(`[bot ${b.params.id}] ${a.kind} on ${a.market} failed: ${(e as Error).message}`);
      }
    }
  }

  private async execute(b: BotRuntime, a: Action): Promise<void> {
    const id = `[bot ${b.params.id}]`;
    const me = b.keypair.publicKey;
    const conn = this.o.rpc.connection; // sends are never auto-failed-over
    const program = getProgram(conn);
    const mint = this.o.mint;

    switch (a.kind) {
      case "skip": {
        if (b.lastSkip.get(a.market) !== a.reason) {
          b.lastSkip.set(a.market, a.reason);
          this.log(`${id} skip ${a.market}: ${a.reason}`);
        }
        return;
      }
      case "place": {
        const market = new PublicKey(a.market);
        // §7 idempotency: re-check on-chain for an existing offer from this bot right before sending.
        const existing = await this.o.rpc.run((c) =>
          fetchOffers(getProgram(c), [filters.offerMarket(market), filters.offerUnderwriter(me)]),
        );
        if (existing.length > 0) return;
        b.inFlight.set(a.market, Date.now() + IN_FLIGHT_MS);
        try {
          const ix = await placeOfferIx(program, {
            underwriter: me,
            market,
            offerNonce: randomNonce(),
            coverage: a.coverage,
            premiumBps: a.bps,
            mint,
          });
          const sig = await sendTx(conn, [ix], [b.keypair]);
          b.inFlight.set(a.market, Date.now() + SETTLE_MS);
          b.lastSkip.delete(a.market);
          this.log(
            `${id} offer ${formatMusd(a.coverage)} mUSD @ ${a.bps} bps on ${a.market} (collateral ${formatMusd(a.collateral)}) ${explorerTx(sig)}`,
          );
        } catch (e) {
          b.inFlight.delete(a.market);
          throw e;
        }
        return;
      }
      case "cancel": {
        if (b.inFlight.has(a.offer)) return;
        b.inFlight.set(a.offer, Date.now() + IN_FLIGHT_MS);
        try {
          const ix = await cancelOfferIx(program, { underwriter: me, offer: new PublicKey(a.offer), mint });
          const sig = await sendTx(conn, [ix], [b.keypair]);
          b.inFlight.set(a.offer, Date.now() + SETTLE_MS);
          this.log(`${id} cancelled offer ${a.offer} (${a.reason}) ${explorerTx(sig)}`);
        } catch (e) {
          b.inFlight.delete(a.offer);
          throw e;
        }
        return;
      }
      case "requote": {
        const market = new PublicKey(a.market);
        b.inFlight.set(a.market, Date.now() + IN_FLIGHT_MS);
        try {
          // §7.1: one transaction, cancel_offer + place_offer.
          const cancel = await cancelOfferIx(program, { underwriter: me, offer: new PublicKey(a.cancelOffer), mint });
          const place = await placeOfferIx(program, {
            underwriter: me,
            market,
            offerNonce: randomNonce(),
            coverage: a.coverage,
            premiumBps: a.bps,
            mint,
          });
          const sig = await sendTx(conn, [cancel, place], [b.keypair]);
          this.limiter.record(me.toBase58(), a.market, Date.now());
          this.log(
            `${id} requote ${a.fromBps} → ${a.bps} bps on ${a.market} (undercut ${a.undercutBps}; #${this.limiter.count(a.market)}) ${explorerTx(sig)}`,
          );
        } finally {
          // Settle either way; the limiter enforces the real 5 s rule.
          b.inFlight.set(a.market, Date.now() + SETTLE_MS);
        }
        return;
      }
      case "list": {
        b.inFlight.set(a.offer, Date.now() + IN_FLIGHT_MS);
        try {
          const ix = await listPositionIx(program, {
            seller: me,
            market: new PublicKey(a.market),
            offer: new PublicKey(a.offer),
            side: Side.Risk,
            price: a.price,
          });
          const sig = await sendTx(conn, [ix], [b.keypair]);
          b.inFlight.set(a.offer, Date.now() + SETTLE_MS);
          this.log(`${id} listed Risk side of ${a.offer} for ${formatMusd(a.price)} mUSD ${explorerTx(sig)}`);
        } catch (e) {
          b.inFlight.delete(a.offer);
          throw e;
        }
        return;
      }
      case "cancelListing": {
        b.inFlight.set(a.offer, Date.now() + IN_FLIGHT_MS);
        try {
          const ix = await cancelListingIx(program, { seller: me, listing: new PublicKey(a.listing) });
          const sig = await sendTx(conn, [ix], [b.keypair]);
          b.inFlight.set(a.offer, Date.now() + SETTLE_MS);
          this.log(`${id} cancelled listing ${a.listing} ${explorerTx(sig)}`);
        } catch (e) {
          b.inFlight.delete(a.offer);
          throw e;
        }
        return;
      }
    }
  }
}
