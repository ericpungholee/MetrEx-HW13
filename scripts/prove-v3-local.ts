// Gate V3 acceptance on a local validator (build-plan-v2 §4 E and D, §5). Loopback RPC only.
// Driven by scripts/v3-local.sh; each phase reads chain state and asserts:
//   --phase demo     books quoted without crosses; §11 replay (market buy 300, limit sell 200 → 100/100);
//                    keeper matches a crossed user pair exactly once; restart rebuilds an identical book
//   --phase reads    with the keeper stopped: book, market and health reads work, matching shows paused
//   --phase settled  after the second prepare run: old round closed and resolved with matching evidence
//                    hashes, a trade on it is rejected, the presenter sweeps and redeems to the base unit
import assert from "node:assert/strict";
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  DEMO_BOTS,
  MAX_PRICE_BPS,
  OrderSide,
  Outcome,
  PAYOUT_PER_SHARE,
  bookFingerprint,
  bestAsk,
  crossedPairs,
  marketAddresses,
  planLimitOrder,
  planMarketOrder,
  randomNonce,
  type OrderFilledEvent,
} from "@metrex/exchange";
import {
  ataOf,
  fetchAllRounds,
  fetchExchangeConfig,
  fetchMarketsOfRound,
  fetchOrders,
  getExchangeProgram,
  getRpc,
  loadKeypair,
  loadMarketBook,
  matchOrdersIx,
  parseTxEvents,
  placeOrderIx,
  redeemIx,
  sendExchangeTx,
  sweepOrderIx,
  takeOrderIx,
  tokenBalance,
  TradeStore,
  tradeDecoder,
  tradeStorePath,
  type MarketView,
} from "@metrex/server/exchange";
import { getExchangeEvidence, handleBook, handleHealth, handleMarket } from "@metrex/server";
import { describeExchangeError } from "@metrex/exchange";
import { flagValue } from "./lib/common";
import { isLoopback } from "./lib/v2";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpc = getRpc();
const conn = rpc.connection;
const p = getExchangeProgram(conn);
const ok = (s: string) => console.log(`  ok    ${s}`);
const BOT_KEYS = { A: "botA", B: "botB", C: "botC" } as const;
const bots = Object.fromEntries(DEMO_BOTS.map((b) => [loadKeypair(BOT_KEYS[b.name as "A"]).publicKey.toBase58(), b.name]));

async function latestMarkets() {
  const config = await fetchExchangeConfig(p);
  assert(config, "Config missing");
  const markets = await fetchMarketsOfRound(p, config.latestRound);
  const featured = markets.find((m) => m.propertyId === 1);
  const other = markets.find((m) => m.propertyId === 2);
  assert(featured && other, "markets for properties 1 and 2 missing");
  return { config, featured, other, collateral: config.collateralMint };
}

async function fills(sig: string): Promise<OrderFilledEvent[]> {
  const tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  assert(tx?.meta, "transaction not found");
  return parseTxEvents(p, { signature: sig, slot: tx.slot, blockTime: tx.blockTime ?? null, logs: tx.meta.logMessages ?? [] }).filter(
    (e): e is OrderFilledEvent & { pos: never } => e.name === "OrderFilled",
  );
}

async function phaseDemo(): Promise<void> {
  const { featured, other, collateral } = await latestMarkets();
  const presenter = loadKeypair("homeownerDemo");
  const judge = loadKeypair("judge1");

  console.log("\n== books: three bots on both books of both markets, never crossed (10 s of samples)");
  const until = Date.now() + 10_000;
  let samples = 0;
  while (Date.now() < until) {
    for (const m of [featured, other]) {
      const s = await loadMarketBook(conn, m.address, collateral);
      assert(s);
      for (const o of [Outcome.Yes, Outcome.No]) assert.deepEqual(crossedPairs(s.book, o), [], `crossed ${m.propertyId}/${o}`);
      for (const maker of Object.keys(bots)) for (const o of [0, 1]) for (const side of [0, 1]) {
        assert(s.book.some((x) => x.maker === maker && x.outcome === o && x.side === side), `bot ${bots[maker]} missing ${o}/${side} on ${m.propertyId}`);
      }
    }
    samples++;
    await sleep(500);
  }
  ok(`${samples} samples × 2 markets × 2 books: all 12 bot levels present, no crosses`);

  console.log("\n== §11 0:35 market buy 300 YES (one signature)");
  let snap = await loadMarketBook(conn, featured.address, collateral);
  assert(snap);
  const worst = Math.min(MAX_PRICE_BPS, (bestAsk(snap.book, Outcome.Yes)?.priceBps ?? 0) + 200);
  const buy = planMarketOrder(snap.book, { outcome: Outcome.Yes, side: OrderSide.Buy, qty: 300n, worstPriceBps: worst, taker: presenter.publicKey.toBase58() });
  const byId = new Map(snap.orders.map((o) => [o.address, o]));
  const takes = await Promise.all(buy.fills.map((f) => takeOrderIx(p, featured, presenter.publicKey, collateral, byId.get(f.orderId)!, f.qty, worst)));
  const musd0 = await tokenBalance(conn, ataOf(collateral, presenter.publicKey));
  const sigBuy = await sendExchangeTx(conn, takes, [presenter]);
  const fb = await fills(sigBuy);
  assert.deepEqual(fb.map((f) => [bots[f.seller], f.quantity, f.priceBps]), [["A", 200n, 430], ["B", 100n, 500]]);
  const cost = fb.reduce((a, f) => a + f.quoteAmount, 0n);
  assert.equal(cost, 13_600_000n);
  assert.equal(musd0 - (await tokenBalance(conn, ataOf(collateral, presenter.publicKey))), 13_600_000n);
  assert.equal(await tokenBalance(conn, ataOf(featured.yesMint, presenter.publicKey)), 300n);
  ok(`fills A 200 @ 430 + B 100 @ 500 = 13.6 mUSD exactly; presenter holds 300 YES (${sigBuy})`);

  console.log("\n== §11 1:15 limit sell 200 YES @ 410: place + match in one transaction");
  await sleep(4_000); // bots requote after the fills
  snap = await loadMarketBook(conn, featured.address, collateral);
  assert(snap);
  const sell = planLimitOrder(snap.book, { outcome: Outcome.Yes, side: OrderSide.Sell, qty: 200n, priceBps: 410, maker: presenter.publicKey.toBase58() });
  assert.deepEqual(sell.fills.map((f) => [bots[f.maker], f.qty, f.priceBps]), [["C", 100n, 410]], "preview: 100 fills now");
  assert.equal(sell.rests, 100n, "preview: 100 rests");
  const nonce = randomNonce();
  const placed = await placeOrderIx(p, featured, presenter.publicKey, collateral, { clientNonce: nonce, outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 410, quantity: 200n });
  const ixs: TransactionInstruction[] = [placed.ix];
  for (const f of sell.fills) {
    const b = snap.orders.find((o) => o.address === f.orderId)!;
    ixs.push(...(await matchOrdersIx(p, featured, presenter.publicKey, collateral, b, { address: placed.order.toBase58(), maker: presenter.publicKey.toBase58() }, f.qty)));
  }
  const musd1 = await tokenBalance(conn, ataOf(collateral, presenter.publicKey));
  const sigSell = await sendExchangeTx(conn, ixs, [presenter]);
  const fs = await fills(sigSell);
  assert.deepEqual(fs.map((f) => [bots[f.buyer], f.quantity, f.priceBps, f.quoteAmount]), [["C", 100n, 410, 4_100_000n]]);
  assert.equal((await tokenBalance(conn, ataOf(collateral, presenter.publicKey))) - musd1, 4_100_000n);
  const presenterOrder = await p.account.order.fetch(placed.order);
  assert.equal(presenterOrder.remainingQty.toString(), "100");
  ok(`100 filled at Bot C's 410 for 4.1 mUSD; order shows 200 / 100 resting (${sigSell})`);

  console.log("\n== bots requote; the resting 100 stays uncrossed");
  await sleep(8_000);
  snap = await loadMarketBook(conn, featured.address, collateral);
  assert(snap);
  assert.deepEqual(crossedPairs(snap.book, Outcome.Yes), []);
  const botBids = snap.book.filter((o) => bots[o.maker] && o.outcome === Outcome.Yes && o.side === OrderSide.Buy).map((o) => o.priceBps);
  assert(Math.max(...botBids) <= 409, `bot bid ${Math.max(...botBids)} > 409`);
  assert.equal((await p.account.order.fetch(placed.order)).remainingQty.toString(), "100");
  ok(`best bot bid ${Math.max(...botBids)} ≤ 409; presenter still rests 100 @ 410`);

  console.log("\n== keeper clears a race-left cross exactly once (place only, no match)");
  const jNonce = randomNonce();
  const jp = await placeOrderIx(p, featured, judge.publicKey, collateral, { clientNonce: jNonce, outcome: Outcome.Yes, side: OrderSide.Buy, priceBps: 415, quantity: 20n });
  await sendExchangeTx(conn, [jp.ix], [judge]);
  let matched = false;
  for (let i = 0; i < 30 && !matched; i++) {
    await sleep(1_000);
    matched = (await p.account.order.fetch(jp.order)).remainingQty.toString() === "0";
  }
  assert(matched, "keeper did not match the crossed pair within 30 s");
  const journal = tradeStorePath(p.programId.toBase58());
  const idx = new TradeStore(journal, tradeDecoder(getRpc()));
  const matchingFills = () => idx.trades(featured.address.toBase58()).filter((t) =>
    t.fill.buyOrder === jp.order.toBase58() && t.fill.sellOrder === placed.order.toBase58(),
  );
  for (let i = 0; i < 45 && !matchingFills().length; i++) {
    idx.reload();
    if (!matchingFills().length) await sleep(1_000);
  }
  idx.reload();
  const pair = matchingFills();
  assert.equal(pair.length, 1, `expected one match, got ${pair.length}`);
  assert.equal(pair[0]!.fill.priceBps, 410, "older (resting) price");
  assert.equal(pair[0]!.fill.quantity, 20n);
  assert.equal(pair[0]!.fill.buyerRefund, 20n * 5n * 100n, "price improvement refunded to the buyer");
  assert.equal((await p.account.order.fetch(placed.order)).remainingQty.toString(), "80");
  ok(`one OrderFilled 20 @ 410 (older price), refund 0.01 mUSD to the buyer, presenter rests 80 (${pair[0]!.signature})`);

  console.log("\n== restart: fresh loaders rebuild an identical book and trade index");
  await sleep(3_000);
  const a = await loadMarketBook(conn, featured.address, collateral);
  const b = await loadMarketBook(conn, featured.address, collateral);
  assert(a && b);
  if (a.market.nextOrderSeq === b.market.nextOrderSeq) assert.equal(bookFingerprint(b.book), bookFingerprint(a.book));
  idx.reload();
  const reopened = new TradeStore(journal, tradeDecoder(getRpc()));
  const ser = (x: TradeStore) => JSON.stringify(x.trades(featured.address.toBase58()), (_, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.equal(ser(reopened), ser(idx));
  ok(`book fingerprint identical (${a.book.length} orders); ${reopened.trades(featured.address.toBase58()).length} fills recovered from the journal`);
}

async function phaseReads(): Promise<void> {
  const { featured } = await latestMarkets();
  console.log("\n== reads with the keeper stopped");
  const book = await handleBook(new Request(`http://x/api/markets/${featured.address}/book?outcome=yes`), featured.address.toBase58());
  assert.equal(book.status, 200);
  const body = (await book.json()) as { book: { bids: unknown[]; asks: unknown[] } };
  assert(body.book.bids.length > 0 && body.book.asks.length > 0, "book empty");
  const mk = await handleMarket(featured.address.toBase58());
  assert.equal(mk.status, 200);
  const h = (await (await handleHealth()).json()) as { matching: string; rpc: { ok: boolean }; bots: { alive: boolean } };
  assert.equal(h.matching, "paused");
  assert(h.rpc.ok && h.bots.alive);
  ok(`book ${body.book.bids.length} bid / ${body.book.asks.length} ask levels; market 200; health: matching paused, bots alive, RPC ok`);
}

async function phaseSettled(): Promise<void> {
  const presenter = loadKeypair("homeownerDemo");
  const rounds = await fetchAllRounds(p);
  const config = await fetchExchangeConfig(p);
  assert(config);
  const latest = rounds[rounds.length - 1]!;
  assert(latest.address.equals(config.latestRound) && latest.status === "open", "a fresh round is open");
  const prevId = BigInt(flagValue("--round") ?? (latest.roundId - 1n).toString());
  const prev = rounds.find((r) => r.roundId === prevId);
  assert(prev, `round ${prevId} not found`);
  console.log(`\n== round ${prev.roundId} closed and settled by the second prepare run; round ${latest.roundId} open`);
  assert.equal(prev.status, "closed");
  assert.equal(prev.resolvedCount, prev.marketCount);
  const ms = await fetchMarketsOfRound(p, prev.address);
  for (const m of ms) {
    const ev = await getExchangeEvidence(m.address);
    assert.equal(ev.hashHex, Buffer.from(m.evidenceHash).toString("hex"));
    assert.equal(ev.record.version, 2);
    assert.equal(ev.record.round, prev.address.toBase58());
    ok(`property ${m.propertyId}: ${m.outcome.toUpperCase()} via oracle path ${m.resolutionPath}; evidence v2 hash ${ev.hashHex.slice(0, 16)}… matches on-chain`);
  }
  assert.deepEqual(ms.map((m) => [m.propertyId, m.outcome]), [[1, "yes"], [2, "no"]], "featured settles YES, property 2 NO (spec-v2 §11)");

  const f = ms.find((m) => m.propertyId === 1) as MarketView;
  const collateral = config.collateralMint;
  console.log("\n== trading on the closed round is rejected (simulated take_order)");
  const anyOrder = (await fetchOrders(p, { market: f.address }))[0];
  const other = await fetchOrders(p, { market: marketAddresses(p.programId, latest.address, 1).market });
  const target = anyOrder ?? other[0];
  if (target) {
    const ix = await takeOrderIx(p, f, presenter.publicKey, collateral, target, 1n, target.side === OrderSide.Sell ? MAX_PRICE_BPS : 1);
    const tx = new Transaction().add(ix);
    tx.feePayer = presenter.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sim = await conn.simulateTransaction(tx);
    const why = describeExchangeError(sim.value.logs ?? []) ?? JSON.stringify(sim.value.err);
    assert(sim.value.err, "trade on a closed round must fail");
    ok(`rejected: ${why}`);
  } else ok("no order left to simulate against (all swept); close was verified by status");

  console.log("\n== presenter redeems (sweeps of its orders already ran)");
  const left = (await fetchOrders(p, { maker: presenter.publicKey })).filter((o) => o.market === f.address.toBase58());
  const ixs: TransactionInstruction[] = [];
  for (const o of left) ixs.push(await sweepOrderIx(p, f, presenter.publicKey, collateral, o));
  const yes = await tokenBalance(conn, ataOf(f.yesMint, presenter.publicKey));
  const escrowed = left.filter((o) => o.side === OrderSide.Sell && o.outcome === Outcome.Yes).reduce((a, o) => a + o.remainingQty, 0n);
  const q = yes + escrowed;
  assert(q > 0n, "presenter holds winning YES");
  ixs.push(await redeemIx(p, f, presenter.publicKey, collateral, Outcome.Yes, q));
  const before = await tokenBalance(conn, ataOf(collateral, presenter.publicKey));
  const sig = await sendExchangeTx(conn, ixs, [presenter]);
  const after = await tokenBalance(conn, ataOf(collateral, presenter.publicKey));
  assert.equal(after - before, q * PAYOUT_PER_SHARE);
  assert.equal(await tokenBalance(conn, ataOf(f.yesMint, presenter.publicKey)), 0n);
  ok(`redeemed ${q} YES for exactly ${q} mUSD (${after - before} base units) ${sig}`);

}

async function main(): Promise<void> {
  if (!isLoopback(conn.rpcEndpoint)) throw new Error("prove-v3-local runs against a loopback validator only");
  const phase = flagValue("--phase");
  if (phase === "demo") await phaseDemo();
  else if (phase === "reads") await phaseReads();
  else if (phase === "settled") await phaseSettled();
  else throw new Error("--phase demo|reads|settled");
  console.log(`\nphase ${phase}: PASS`);
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(`\nFAIL: ${(e as Error).message}`);
  process.exit(1);
});
