// rehearse-v7.ts (docs/spec-simulation.md §7–§8): the homeowner path on a DISPOSABLE catalog round,
// against the running app. The homeowner demo wallet (a stand-in for Phantom) buys YES coverage
// and a small NO position at the live book, the operator API fast-forwards that one round, and the
// script measures time to redeemable, redeems, checks the exact mUSD increase, and checks the
// ledger and that the other three markets kept trading. The oracle alone decides the outcome.
// Never run it on the final presentation markets.
//   DEMO_PASSWORD=… pnpm tsx scripts/rehearse-v7.ts --hazard wildfire [--yes 30000] [--no 1000]
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { CATALOG, INVALID_PAYOUT_PER_SHARE, OrderSide, Outcome, PAYOUT_PER_SHARE, planMarketOrder, type OutcomeCode } from "@metrex/exchange";
import {
  ExchangeStateLoader, ataOf, createAtaIdempotentIx, explorerTx, fetchExchangeMarket, getExchangeProgram, getRpc,
  loadKeypair, redeemIx, sendExchangeTx, takeOrderIx, tokenBalance, type MarketBookSnapshot,
} from "@metrex/server/exchange";
import { DEVNET_GENESIS } from "./lib/v2";
import { flagValue } from "./lib/common";

async function main(): Promise<void> {
  const rpc = getRpc();
  const conn = rpc.connection;
  const program = getExchangeProgram(conn);
  assert.equal(await rpc.run((c) => c.getGenesisHash()), DEVNET_GENESIS, "Devnet required");
  const root = process.env.METREX_APP_ORIGIN ?? "http://127.0.0.1:3015";
  const password = process.env.DEMO_PASSWORD;
  assert(password, "Set DEMO_PASSWORD");
  const hazard = flagValue("--hazard") ?? "wildfire";
  const entry = CATALOG.find((c) => c.hazard === hazard);
  assert(entry, "unknown --hazard");
  const wantYes = BigInt(flagValue("--yes") ?? "30000");
  const wantNo = BigInt(flagValue("--no") ?? "1000");
  const me = loadKeypair("homeownerDemo");
  const loader = new ExchangeStateLoader();
  const load = async () => (await rpc.run((c) => loader.load(c, { roundsBack: 16 })))!;
  const featured = (s: Awaited<ReturnType<typeof load>>, propertyId: number) =>
    s.snapshots.filter((x) => x.market.propertyId === propertyId && CATALOG.some((c) => c.propertyId === propertyId && c.scenarioId === x.round.scenarioId)).at(-1)!;
  let state = await load();
  let snap: MarketBookSnapshot = featured(state, entry.propertyId);
  assert(snap.tradingOpen, `${hazard} market is not trading`);
  const m = snap.market;
  const usd = state.config.collateralMint;
  console.log(`market ${m.address.toBase58()} round #${snap.round.roundId} (${root}/market/${m.address.toBase58()})`);

  const buy = async (outcome: OutcomeCode, qty: bigint) => {
    let left = qty;
    while (left > 0n) {
      state = await load();
      snap = featured(state, entry.propertyId);
      const plan = planMarketOrder(snap.book, { outcome, side: OrderSide.Buy, qty: left, worstPriceBps: 9_999, taker: me.publicKey.toBase58() });
      assert(plan.fills.length, "no executable liquidity");
      const ixs = [createAtaIdempotentIx(me.publicKey, me.publicKey, outcome === Outcome.Yes ? m.yesMint : m.noMint)];
      for (const f of plan.fills) {
        const o = snap.book.find((x) => x.id === f.orderId)!;
        ixs.push(await takeOrderIx(program, m, me.publicKey, usd, { address: o.id, maker: o.maker, outcome: o.outcome, side: o.side, seq: o.seq }, f.qty, o.priceBps));
      }
      const filled = plan.fills.reduce((a, f) => a + f.qty, 0n);
      const sig = await sendExchangeTx(conn, ixs, [me]);
      console.log(`buy ${filled} ${outcome === Outcome.Yes ? "YES" : "NO"} for ${plan.totalQuote / 1_000_000n} mUSD ${explorerTx(sig)}`);
      left -= filled;
    }
  };
  const usdAta = ataOf(usd, me.publicKey);
  const musd0 = await tokenBalance(conn, usdAta);
  await buy(Outcome.Yes, wantYes);
  if (wantNo > 0n) await buy(Outcome.No, wantNo);
  const yes = await tokenBalance(conn, ataOf(m.yesMint, me.publicKey));
  const no = await tokenBalance(conn, ataOf(m.noMint, me.publicKey));
  const musd1 = await tokenBalance(conn, usdAta);
  console.log(`holding ${yes} YES, ${no} NO; paid ${(musd0 - musd1) / 1_000_000n} mUSD`);

  // Fast-forward through the operator API; meanwhile poll the market independently at confirmed.
  const t0 = Date.now();
  let redeemableMs: number | null = null;
  const watch = (async () => {
    while (redeemableMs === null && Date.now() - t0 < 120_000) {
      const mk = await rpc.run((c) => fetchExchangeMarket(getExchangeProgram(c), m.address, "confirmed")).catch(() => null);
      if (mk && mk.outcome !== "unresolved") redeemableMs = Date.now() - t0;
      else await delay(500);
    }
  })();
  const res = await fetch(new URL("/api/operator/settle-round", root), {
    method: "POST", headers: { "content-type": "application/json", "x-demo-password": password },
    body: JSON.stringify({ action: "fast_forward", round: snap.round.address.toBase58() }),
  });
  const ff = await res.json() as { timings?: Record<string, number>; proof?: { explorer: string } | null; proofNote?: string; steps?: Array<{ step: string; explorer: string | null }> };
  assert(res.ok, `fast_forward: ${res.status} ${JSON.stringify(ff)}`);
  await watch;
  console.log(`fast-forward ${JSON.stringify(ff.timings)}; observed redeemable after ${redeemableMs} ms`);
  for (const s of ff.steps ?? []) console.log(`  ${s.step} ${s.explorer ?? ""}`);
  console.log(ff.proof ? `  closure proof ${ff.proof.explorer}` : `  closure proof skipped: ${ff.proofNote}`);

  const settled = (await rpc.run((c) => fetchExchangeMarket(getExchangeProgram(c), m.address, "finalized")))!;
  console.log(`oracle outcome: ${settled.outcome.toUpperCase()} (evidence ${Buffer.from(settled.evidenceHash).toString("hex").slice(0, 16)}…)`);
  const per = (side: "yes" | "no") => settled.outcome === "invalid" ? INVALID_PAYOUT_PER_SHARE : settled.outcome === side ? PAYOUT_PER_SHARE : 0n;
  const expected = yes * per("yes") + no * per("no");
  const redeem: Array<[OutcomeCode, bigint]> = [];
  if (per("yes") > 0n && yes > 0n) redeem.push([Outcome.Yes, yes]);
  if (per("no") > 0n && no > 0n) redeem.push([Outcome.No, no]);
  if (redeem.length) {
    const t = Date.now();
    const sig = await sendExchangeTx(conn, await Promise.all(redeem.map(([o, q]) => redeemIx(program, settled, me.publicKey, usd, o, q))), [me]);
    console.log(`redeemed in ${Date.now() - t} ms ${explorerTx(sig)}`);
  }
  const musd2 = await tokenBalance(conn, usdAta);
  assert.equal(musd2 - musd1, expected, "mUSD increase must equal the booked payout exactly");
  console.log(`mUSD +${(musd2 - musd1) / 1_000_000n} = expected ${expected / 1_000_000n}; net ${(musd2 - musd0) / 1_000_000n} mUSD on this position`);

  // Ledger (finalized events): this wallet's row and reconciliation.
  let ledger: { participants: Array<{ wallet: string; spent: string; redeemed: string; claimable: string; netPnl: string | null }>; totals: { pnlSum: string | null; trades: number; volume: string }; reconciliation: Record<string, unknown> } | null = null;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(new URL(`/api/markets/${m.address.toBase58()}/ledger`, root));
    if (r.ok) {
      ledger = await r.json() as typeof ledger;
      const row = ledger!.participants.find((p) => p.wallet === me.publicKey.toBase58());
      if (row && BigInt(row.redeemed) === expected) break;
    }
    await delay(3_000);
  }
  assert(ledger, "ledger unavailable");
  const row = ledger.participants.find((p) => p.wallet === me.publicKey.toBase58());
  console.log(`ledger: ${ledger.totals.trades} trades, volume ${BigInt(ledger.totals.volume) / 1_000_000n} mUSD, P&L sum ${ledger.totals.pnlSum}, you: ${JSON.stringify(row)}`);
  console.log(`reconciliation ${JSON.stringify(ledger.reconciliation)}`);

  // Other markets keep trading.
  state = await load();
  for (const c of CATALOG.filter((x) => x.propertyId !== entry.propertyId)) {
    const s = featured(state, c.propertyId);
    console.log(`  ${c.hazard}: round #${s.round.roundId} ${s.tradingOpen ? "trading" : s.round.status}, ${s.book.length} resting orders`);
  }
}

main().catch((e: unknown) => {
  console.error(`rehearse-v7 failed: ${(e as Error).message}`);
  process.exit(1);
});
