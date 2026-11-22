// e2e-judge-flow.ts: the 3-minute judging sequence on Devnet, end to end, against the running app.
// A stand-in wallet (homeownerDemo, never Phantom) trades the live wildfire book with the trade
// ticket's own rule: market orders accept a fixed 5% from the best executable price
// (spec-multiperil §7.4, app/lib/exchange-client.ts previewTrade). Every fill is a real take_order
// against a funded resting order. Then Settle market (operator fast-forward, oracle decides), redeem,
// and an exact balance check. --reset finally opens a fresh round so no judge-facing transaction is
// left pre-executed. Nothing here bypasses a program check.
//   node --env-file-if-exists=app/.env.local --import tsx scripts/e2e-judge-flow.ts [--hazard wildfire] [--skip-trades] [--no-settle] [--reset]
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  CATALOG, MAX_PRICE_BPS, MIN_PRICE_BPS, OrderSide, Outcome, PAYOUT_PER_SHARE, planMarketOrder, sorted,
  type BookOrder, type OrderSideCode, type OutcomeCode,
} from "@metrex/exchange";
import {
  ExchangeStateLoader, ataOf, createAtaIdempotentIx, explorerTx, fetchExchangeMarket, getExchangeProgram, getRpc,
  loadKeypair, redeemIx, sendExchangeTx, takeOrderIx, tokenBalance, type MarketBookSnapshot,
} from "@metrex/server/exchange";
import { PublicKey } from "@solana/web3.js";
import { DEVNET_GENESIS } from "./lib/v2";
import { args, flagValue } from "./lib/common";

const TOLERANCE_BPS = 500;
const name = (o: OutcomeCode) => (o === Outcome.Yes ? "YES" : "NO");
const musd = (x: bigint) => `${x < 0n ? "-" : ""}${(x < 0n ? -x : x) / 1_000_000n}.${String((x < 0n ? -x : x) % 1_000_000n).padStart(6, "0")}`;

/** The trade ticket's worst price: best ± floor(best × 5%), clamped (exchange-client.ts previewTrade). */
export function worstPrice(book: readonly BookOrder[], outcome: OutcomeCode, side: OrderSideCode, me: string): number | null {
  const best = sorted(book, outcome, side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy).find((o) => o.maker !== me);
  if (!best) return null;
  const slip = Math.floor((best.priceBps * TOLERANCE_BPS) / 10_000);
  return Math.max(MIN_PRICE_BPS, Math.min(MAX_PRICE_BPS, side === OrderSide.Buy ? best.priceBps + slip : best.priceBps - slip));
}

async function main(): Promise<void> {
  const rpc = getRpc();
  const conn = rpc.connection;
  const program = getExchangeProgram(conn);
  assert.equal(await rpc.run((c) => c.getGenesisHash()), DEVNET_GENESIS, "Devnet required");
  const root = process.env.METREX_APP_ORIGIN ?? "http://127.0.0.1:3015";
  const entry = CATALOG.find((c) => c.hazard === (flagValue("--hazard") ?? "wildfire"));
  assert(entry, "unknown --hazard");
  const me = loadKeypair("homeownerDemo");
  const who = me.publicKey.toBase58();
  const loader = new ExchangeStateLoader();
  let usd = PublicKey.default;
  const snapshot = async (): Promise<MarketBookSnapshot> => {
    const s = (await rpc.run((c) => loader.load(c, { roundsBack: 16 })))!;
    usd = s.config.collateralMint;
    return s.snapshots.filter((x) => x.market.propertyId === entry.propertyId && x.round.scenarioId === entry.scenarioId).at(-1)!;
  };
  let snap = await snapshot();
  assert(snap.tradingOpen, `${entry.hazard} market is not trading`);
  const m = snap.market;
  const usdAta = ataOf(usd, me.publicKey);
  const ata = (o: OutcomeCode) => ataOf(o === Outcome.Yes ? m.yesMint : m.noMint, me.publicKey);
  console.log(`market ${m.address.toBase58()} round #${snap.round.roundId}  ${root}/market/${m.address.toBase58()}`);
  const results: string[] = [];

  /** One market order exactly as the ticket would send it. Returns the fills. */
  const trade = async (label: string, outcome: OutcomeCode, side: OrderSideCode, qty: bigint, opts: { minFills?: number } = {}) => {
    snap = await snapshot();
    const worst = worstPrice(snap.book, outcome, side, who);
    assert(worst !== null, `${label}: empty book`);
    const plan = planMarketOrder(snap.book, { outcome, side, qty, worstPriceBps: worst, taker: who });
    const filled = plan.fills.reduce((a, f) => a + f.qty, 0n);
    console.log(`${label}: ${filled}/${qty} plannable within ${worst} bps across ${plan.fills.length} order(s) ${plan.fills.map((f) => `${f.qty}@${f.priceBps}`).join(", ")}`);
    assert.equal(filled, qty, `${label}: only ${filled} of ${qty} can fill within the 5% tolerance`);
    if (opts.minFills) assert(plan.fills.length >= opts.minFills, `${label}: needed ${opts.minFills} orders`);
    const ixs = [createAtaIdempotentIx(me.publicKey, me.publicKey, outcome === Outcome.Yes ? m.yesMint : m.noMint)];
    for (const f of plan.fills) {
      const o = snap.book.find((x) => x.id === f.orderId)!;
      ixs.push(await takeOrderIx(program, m, me.publicKey, usd, { address: o.id, maker: o.maker, outcome: o.outcome, side: o.side, seq: o.seq }, f.qty, f.priceBps));
    }
    const [u0, s0] = [await tokenBalance(conn, usdAta), await tokenBalance(conn, ata(outcome))];
    const sig = await sendExchangeTx(conn, ixs, [me]);
    const [u1, s1] = [await tokenBalance(conn, usdAta), await tokenBalance(conn, ata(outcome))];
    const buy = side === OrderSide.Buy;
    assert.equal(s1 - s0, buy ? qty : -qty, `${label}: share delta`);
    assert.equal(u1 - u0, buy ? -plan.totalQuote : plan.totalQuote, `${label}: mUSD delta must equal the quoted fills exactly`);
    const line = `${label}: ${buy ? "bought" : "sold"} ${qty} ${name(outcome)} for ${musd(plan.totalQuote)} mUSD in ${plan.fills.length} fill(s); ${name(outcome)} ${s0}→${s1}, mUSD ${musd(u0)}→${musd(u1)}  ${explorerTx(sig)}`;
    console.log(`  ✓ ${line}`);
    results.push(line);
    return plan.fills;
  };

  if (!args.includes("--skip-trades")) await trades();
  async function trades() {
  await trade("buy 10 YES", Outcome.Yes, OrderSide.Buy, 10n);
  await trade("buy 100 YES", Outcome.Yes, OrderSide.Buy, 100n);
  await trade("sell 10 YES", Outcome.Yes, OrderSide.Sell, 10n);

  // Multi-order: the smallest quantity that needs two resting orders within the tolerance, on the
  // cheapest book where that exists right now. Reported as not available otherwise (not faked).
  snap = await snapshot();
  const held = { [Outcome.Yes]: await tokenBalance(conn, ata(Outcome.Yes)), [Outcome.No]: await tokenBalance(conn, ata(Outcome.No)) };
  const cash = await tokenBalance(conn, usdAta);
  let multi: string | null = null;
  for (const [outcome, side] of [[Outcome.Yes, OrderSide.Buy], [Outcome.Yes, OrderSide.Sell], [Outcome.No, OrderSide.Buy]] as const) {
    const worst = worstPrice(snap.book, outcome, side, who);
    if (worst === null) continue;
    const levels = sorted(snap.book, outcome, side === OrderSide.Buy ? OrderSide.Sell : OrderSide.Buy)
      .filter((o) => o.maker !== who && (side === OrderSide.Buy ? o.priceBps <= worst : o.priceBps >= worst));
    if (levels.length < 2) continue;
    const qty = levels[0]!.remaining + 1n;
    const plan = planMarketOrder(snap.book, { outcome, side, qty, worstPriceBps: worst, taker: who });
    if (side === OrderSide.Buy ? plan.totalQuote > cash / 2n : qty > held[outcome]) continue;
    await trade(`multi-order ${side === OrderSide.Buy ? "buy" : "sell"} ${qty} ${name(outcome)}`, outcome, side, qty, { minFills: 2 });
    multi = "done";
    break;
  }
  if (!multi) {
    console.log("  – multi-order take: no book currently has two resting orders within 5% of the best price that this wallet can afford; not tested this run");
    results.push("multi-order take: not available in the live book this run (not tested)");
  }
  }

  if (args.includes("--no-settle")) return void console.log(results.join("\n"));

  // Settle market, exactly as the market-page button does.
  const yes = await tokenBalance(conn, ata(Outcome.Yes));
  const no = await tokenBalance(conn, ata(Outcome.No));
  const t0 = Date.now();
  const res = await fetch(new URL("/api/operator/settle-round", root), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "fast_forward", round: snap.round.address.toBase58(), market: m.address.toBase58() }),
  });
  const ff = await res.json() as { steps?: Array<{ step: string; explorer: string | null }>; proof?: { explorer: string } | null; proofNote?: string; timings?: unknown };
  assert(res.ok, `fast_forward ${res.status} ${JSON.stringify(ff)}`);
  console.log(`settle: ${Date.now() - t0} ms ${JSON.stringify(ff.timings)}`);
  for (const s of ff.steps ?? []) results.push(`settle ${s.step}: ${s.explorer ?? "(no transaction)"}`);
  if (ff.proof) results.push(`closure proof (rejected take after close): ${ff.proof.explorer}`);

  let settled = await rpc.run((c) => fetchExchangeMarket(getExchangeProgram(c), m.address, "finalized"));
  for (let i = 0; i < 30 && settled?.outcome === "unresolved"; i++) {
    await delay(1_000);
    settled = await rpc.run((c) => fetchExchangeMarket(getExchangeProgram(c), m.address, "finalized"));
  }
  assert(settled && settled.outcome !== "unresolved", "market did not finalize");
  console.log(`oracle outcome ${settled.outcome.toUpperCase()}, evidence ${Buffer.from(settled.evidenceHash).toString("hex")}`);
  results.push(`oracle outcome: ${settled.outcome.toUpperCase()} (evidence sha256 ${Buffer.from(settled.evidenceHash).toString("hex")})`);

  const win = settled.outcome === "yes" ? Outcome.Yes : settled.outcome === "no" ? Outcome.No : null;
  assert(win !== null, `outcome ${settled.outcome}: this flow expects a decided market`);
  const qty = win === Outcome.Yes ? yes : no;
  const u0 = await tokenBalance(conn, usdAta);
  const sig = await sendExchangeTx(conn, [await redeemIx(program, settled, me.publicKey, usd, win, qty)], [me]);
  const u1 = await tokenBalance(conn, usdAta);
  assert.equal(u1 - u0, qty * PAYOUT_PER_SHARE, "redeem must pay exactly 1 mUSD per winning share");
  assert.equal(await tokenBalance(conn, ata(win)), 0n, "winning shares burned");
  results.push(`redeem ${qty} ${name(win)}: mUSD ${musd(u0)}→${musd(u1)} (+${musd(u1 - u0)})  ${explorerTx(sig)}`);

  if (args.includes("--reset")) {
    const r = await fetch(new URL("/api/operator/demo", root), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "reset_market", round: snap.round.address.toBase58() }),
    });
    assert(r.status === 202, `reset_market ${r.status} ${await r.text()}`);
    for (let i = 0; i < 120; i++) {
      await delay(2_000);
      const st = await (await fetch(new URL("/api/operator/demo?operation=1", root))).json() as { operation: { running: boolean; status?: string; error?: string } | null };
      if (st.operation && !st.operation.running) {
        results.push(`reset_market: ${JSON.stringify({ status: st.operation.status, error: st.operation.error })}`);
        break;
      }
    }
    const fresh = await snapshot();
    results.push(`fresh round #${fresh.round.roundId}: market ${fresh.market.address.toBase58()}, trading ${fresh.tradingOpen}`);
  }
  console.log(`\nRESULTS\n${results.join("\n")}`);
}

main().catch((e: unknown) => {
  console.error(`e2e-judge-flow failed: ${(e as Error).message}`);
  process.exit(1);
});
