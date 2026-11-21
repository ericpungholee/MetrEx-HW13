// Gate V4 on Devnet (spec-v2 §13.3, build-plan-v2 §5). Every check reads chain state and asserts to
// the base unit; every transaction is printed with its explorer link for docs/v2-devnet-verification.md.
//   pnpm tsx scripts/prove-v4-devnet.ts --phase trade     split + merge, §11 market buy and partial
//                                                         limit sell, cancel, a NO buy on property 2
//   METREX_ORACLE_DATA_DIR=… prepare-demo-v2.ts --new-round   (closes, resolves and sweeps round N)
//   pnpm tsx scripts/prove-v4-devnet.ts --phase settled [--round N]
//                                                         YES and NO hashes match, a trade on the
//                                                         closed round is rejected, YES and NO redeem
// Run the v2 bots and keeper against Devnet first. Refuses any cluster but Devnet.
import assert from "node:assert/strict";
import { Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  DEMO_BOTS,
  MAX_PRICE_BPS,
  OrderSide,
  Outcome,
  PAYOUT_PER_SHARE,
  bestAsk,
  crossedPairs,
  describeExchangeError,
  planLimitOrder,
  planMarketOrder,
  randomNonce,
  type OrderFilledEvent,
} from "@metrex/exchange";
import {
  ataOf,
  cancelOrderIx,
  explorerTx,
  fetchAllRounds,
  fetchExchangeConfig,
  fetchMarketsOfRound,
  fetchOrders,
  getExchangeProgram,
  getRpc,
  loadKeypair,
  loadMarketBook,
  matchOrdersIx,
  mergeIx,
  parseTxEvents,
  placeOrderIx,
  redeemIx,
  sendExchangeTx,
  splitIx,
  sweepOrderIx,
  takeOrderIx,
  tokenBalance,
  type MarketView,
} from "@metrex/server/exchange";
import { getExchangeEvidence } from "@metrex/server";
import { flagValue } from "./lib/common";
import { DEVNET_GENESIS } from "./lib/v2";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpc = getRpc();
const conn = rpc.connection;
const p = getExchangeProgram(conn);
const ok = (s: string, sig?: string) => console.log(`  ok    ${s}${sig ? `\n        ${explorerTx(sig)}` : ""}`);
const BOT_KEYS = { A: "botA", B: "botB", C: "botC" } as const;
const bots = Object.fromEntries(DEMO_BOTS.map((b) => [loadKeypair(BOT_KEYS[b.name as "A"]).publicKey.toBase58(), b.name]));
const presenter = loadKeypair("homeownerDemo");
const NO_QTY = 50n;

async function fills(sig: string): Promise<OrderFilledEvent[]> {
  let tx = null;
  for (let i = 0; i < 10 && !tx; i++) {
    tx = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) await sleep(1_000);
  }
  assert(tx?.meta, "transaction not found");
  return parseTxEvents(p, { signature: sig, slot: tx.slot, blockTime: tx.blockTime ?? null, logs: tx.meta.logMessages ?? [] }).filter(
    (e): e is OrderFilledEvent & { pos: never } => e.name === "OrderFilled",
  );
}

const bal = (mint: MarketView["yesMint"]) => tokenBalance(conn, ataOf(mint, presenter.publicKey));

async function phaseTrade(): Promise<void> {
  const config = await fetchExchangeConfig(p);
  assert(config, "Config missing");
  const markets = await fetchMarketsOfRound(p, config.latestRound);
  const f = markets.find((m) => m.propertyId === 1);
  const o2 = markets.find((m) => m.propertyId === 2);
  assert(f && o2, "markets for properties 1 and 2 missing");
  const usd = config.collateralMint;
  assert.equal(await bal(f.yesMint), 0n, "presenter starts with no YES on the featured market (fresh round)");

  console.log("\n== bot depth: three bots on both books of both markets, never crossed");
  for (const m of [f, o2]) {
    const s = await loadMarketBook(conn, m.address, usd);
    assert(s);
    for (const o of [Outcome.Yes, Outcome.No]) assert.deepEqual(crossedPairs(s.book, o), [], `crossed ${m.propertyId}/${o}`);
    for (const maker of Object.keys(bots)) for (const o of [0, 1]) for (const side of [0, 1]) {
      assert(s.book.some((x) => x.maker === maker && x.outcome === o && x.side === side), `bot ${bots[maker]} missing ${o}/${side} on ${m.propertyId}`);
    }
  }
  ok("property 1 and 2: all 12 bot levels present on each, no crosses");

  console.log("\n== split 10 pairs, then merge 10 pairs (presenter)");
  const u0 = await bal(usd);
  const sigSplit = await sendExchangeTx(conn, [await splitIx(p, f, presenter.publicKey, usd, 10n)], [presenter]);
  assert.equal(u0 - (await bal(usd)), 10n * PAYOUT_PER_SHARE);
  assert.equal(await bal(f.yesMint), 10n);
  assert.equal(await bal(f.noMint), 10n);
  ok("split: −10,000,000 mUSD base units, +10 YES, +10 NO", sigSplit);
  const sigMerge = await sendExchangeTx(conn, [await mergeIx(p, f, presenter.publicKey, usd, 10n)], [presenter]);
  assert.equal(await bal(usd), u0);
  assert.equal(await bal(f.yesMint), 0n);
  assert.equal(await bal(f.noMint), 0n);
  ok("merge: +10,000,000 base units back, YES and NO 0; mUSD equal to the base unit", sigMerge);

  console.log("\n== §11 0:35 market buy 300 YES (one signature)");
  let snap = await loadMarketBook(conn, f.address, usd);
  assert(snap);
  const worst = Math.min(MAX_PRICE_BPS, (bestAsk(snap.book, Outcome.Yes)?.priceBps ?? 0) + 200);
  const buy = planMarketOrder(snap.book, { outcome: Outcome.Yes, side: OrderSide.Buy, qty: 300n, worstPriceBps: worst, taker: presenter.publicKey.toBase58() });
  const byId = new Map(snap.orders.map((o) => [o.address, o]));
  const takes = await Promise.all(buy.fills.map((x) => takeOrderIx(p, f, presenter.publicKey, usd, byId.get(x.orderId)!, x.qty, worst)));
  const u1 = await bal(usd);
  const sigBuy = await sendExchangeTx(conn, takes, [presenter]);
  const fb = await fills(sigBuy);
  assert.deepEqual(fb.map((x) => [bots[x.seller], x.quantity, x.priceBps]), [["A", 200n, 430], ["B", 100n, 500]]);
  assert.equal(fb.reduce((a, x) => a + x.quoteAmount, 0n), 13_600_000n);
  assert.equal(u1 - (await bal(usd)), 13_600_000n);
  assert.equal(await bal(f.yesMint), 300n);
  ok("fills A 200 @ 430 + B 100 @ 500 = 13,600,000 base units; presenter holds 300 YES", sigBuy);

  console.log("\n== §11 1:15 limit sell 200 YES @ 410: place + match in one transaction (partial fill)");
  let sell = planLimitOrder(snap.book, { outcome: Outcome.Yes, side: OrderSide.Sell, qty: 200n, priceBps: 410, maker: presenter.publicKey.toBase58() });
  for (let i = 0; i < 30; i++) {
    snap = await loadMarketBook(conn, f.address, usd);
    assert(snap);
    sell = planLimitOrder(snap.book, { outcome: Outcome.Yes, side: OrderSide.Sell, qty: 200n, priceBps: 410, maker: presenter.publicKey.toBase58() });
    if (sell.fills.length === 1 && bots[sell.fills[0]!.maker] === "C" && sell.fills[0]!.qty === 100n && sell.rests === 100n) break;
    await sleep(1_000);
  }
  assert.deepEqual(sell.fills.map((x) => [bots[x.maker], x.qty, x.priceBps]), [["C", 100n, 410]], "preview: 100 fills now");
  assert.equal(sell.rests, 100n);
  const placed = await placeOrderIx(p, f, presenter.publicKey, usd, { clientNonce: randomNonce(), outcome: Outcome.Yes, side: OrderSide.Sell, priceBps: 410, quantity: 200n });
  const ixs: TransactionInstruction[] = [placed.ix];
  for (const x of sell.fills) {
    const b = snap.orders.find((o) => o.address === x.orderId)!;
    ixs.push(...(await matchOrdersIx(p, f, presenter.publicKey, usd, b, { address: placed.order.toBase58(), maker: presenter.publicKey.toBase58() }, x.qty)));
  }
  const u2 = await bal(usd);
  const sigSell = await sendExchangeTx(conn, ixs, [presenter]);
  const fs = await fills(sigSell);
  assert.deepEqual(fs.map((x) => [bots[x.buyer], x.quantity, x.priceBps, x.quoteAmount]), [["C", 100n, 410, 4_100_000n]]);
  assert.equal((await bal(usd)) - u2, 4_100_000n);
  assert.equal((await p.account.order.fetch(placed.order)).remainingQty.toString(), "100");
  assert.equal(await bal(f.yesMint), 100n, "200 YES escrowed, 100 in the wallet");
  ok("100 filled at Bot C's 410 for 4,100,000 base units; 100 rests @ 410", sigSell);

  console.log("\n== cancel the resting 100: full escrow and rent back to the maker");
  const sol0 = await conn.getBalance(presenter.publicKey, "confirmed");
  const order = (await fetchOrders(p, { maker: presenter.publicKey })).find((o) => o.address === placed.order.toBase58());
  assert(order, "resting order missing");
  const sigCancel = await sendExchangeTx(conn, [await cancelOrderIx(p, f, presenter.publicKey, usd, order)], [presenter]);
  assert.equal(await bal(f.yesMint), 200n, "escrowed 100 YES returned");
  assert.equal(await conn.getAccountInfo(placed.order, "confirmed"), null, "order account closed");
  const sol1 = await conn.getBalance(presenter.publicKey, "confirmed");
  assert(sol1 > sol0, "order and escrow rent refunded (net of the fee)");
  ok(`cancelled: 100 YES back (wallet 200 YES), order closed, +${sol1 - sol0} lamports net rent`, sigCancel);

  console.log(`\n== NO side: market buy ${NO_QTY} NO on property 2 (validated as NO at settlement)`);
  const s2 = await loadMarketBook(conn, o2.address, usd);
  assert(s2);
  const worstNo = Math.min(MAX_PRICE_BPS, (bestAsk(s2.book, Outcome.No)?.priceBps ?? 0) + 200);
  const nb = planMarketOrder(s2.book, { outcome: Outcome.No, side: OrderSide.Buy, qty: NO_QTY, worstPriceBps: worstNo, taker: presenter.publicKey.toBase58() });
  assert.equal(nb.unfilled, 0n, "enough NO depth");
  const byId2 = new Map(s2.orders.map((o) => [o.address, o]));
  const n0 = await bal(o2.noMint);
  const u3 = await bal(usd);
  const sigNo = await sendExchangeTx(conn, await Promise.all(nb.fills.map((x) => takeOrderIx(p, o2, presenter.publicKey, usd, byId2.get(x.orderId)!, x.qty, worstNo))), [presenter]);
  const fn = await fills(sigNo);
  const costNo = fn.reduce((a, x) => a + x.quoteAmount, 0n);
  assert.equal(fn.reduce((a, x) => a + x.quantity, 0n), NO_QTY);
  for (const x of fn) assert.equal(x.quoteAmount, x.quantity * BigInt(x.priceBps) * 100n, "quote = q × bps × 100");
  assert.equal(u3 - (await bal(usd)), costNo);
  assert.equal((await bal(o2.noMint)) - n0, NO_QTY);
  ok(`${fn.map((x) => `${bots[x.seller]} ${x.quantity} @ ${x.priceBps}`).join(" + ")} = ${costNo} base units; presenter holds ${NO_QTY} NO`, sigNo);
}

async function phaseSettled(): Promise<void> {
  const rounds = await fetchAllRounds(p);
  const config = await fetchExchangeConfig(p);
  assert(config);
  const usd = config.collateralMint;
  const latest = rounds.find((r) => r.address.equals(config.latestRound));
  assert(latest && latest.status === "open", "a fresh round is open");
  const prevId = BigInt(flagValue("--round") ?? (latest.roundId - 1n).toString());
  const prev = rounds.find((r) => r.roundId === prevId);
  assert(prev, `round ${prevId} not found`);

  console.log(`\n== round ${prev.roundId}: one close stopped both markets; YES and NO resolved with matching evidence`);
  assert.equal(prev.status, "closed");
  assert.equal(prev.resolvedCount, prev.marketCount);
  const ms = await fetchMarketsOfRound(p, prev.address);
  for (const m of ms) {
    const ev = await getExchangeEvidence(m.address);
    assert.equal(ev.hashHex, Buffer.from(m.evidenceHash).toString("hex"));
    assert.equal(ev.record.version, 2);
    assert.equal(ev.record.round, prev.address.toBase58());
    ok(`property ${m.propertyId}: ${m.outcome.toUpperCase()} via oracle path ${m.resolutionPath}; evidence v2 ${ev.hashHex} matches on-chain`);
  }
  assert.deepEqual(ms.map((m) => [m.propertyId, m.outcome]), [[1, "yes"], [2, "no"]]);
  const f = ms.find((m) => m.propertyId === 1)!;
  const o2 = ms.find((m) => m.propertyId === 2)!;

  console.log("\n== trading on the closed round is rejected (simulated split)");
  const tx = new Transaction().add(await splitIx(p, f, presenter.publicKey, usd, 1n));
  tx.feePayer = presenter.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx);
  assert(sim.value.err, "split on a closed round must fail");
  const why = describeExchangeError(sim.value.logs ?? []) ?? JSON.stringify(sim.value.err);
  assert(/RoundNotOpen|Trading has closed/.test(why) || /MarketResolved|resolved/i.test(why), `unexpected rejection: ${why}`);
  ok(`rejected: ${why}`);

  console.log("\n== redemptions, checked to the base unit");
  for (const [m, outcome, mint, label] of [
    [f, Outcome.Yes, f.yesMint, "YES"],
    [o2, Outcome.No, o2.noMint, "NO"],
  ] as const) {
    const left = (await fetchOrders(p, { maker: presenter.publicKey })).filter((o) => o.market === m.address.toBase58());
    const ixs: TransactionInstruction[] = [];
    for (const o of left) ixs.push(await sweepOrderIx(p, m, presenter.publicKey, usd, o));
    const escrowed = left.filter((o) => o.side === OrderSide.Sell && o.outcome === outcome).reduce((a, o) => a + o.remainingQty, 0n);
    const q = (await bal(mint)) + escrowed;
    assert(q > 0n, `presenter holds winning ${label}`);
    ixs.push(await redeemIx(p, m, presenter.publicKey, usd, outcome, q));
    const before = await bal(usd);
    const sig = await sendExchangeTx(conn, ixs, [presenter]);
    const after = await bal(usd);
    assert.equal(after - before, q * PAYOUT_PER_SHARE);
    assert.equal(await bal(mint), 0n);
    ok(`property ${m.propertyId}: redeemed ${q} ${label} for exactly ${after - before} base units`, sig);
  }
}

async function main(): Promise<void> {
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("RPC is not Solana Devnet");
  const phase = flagValue("--phase");
  if (phase === "trade") await phaseTrade();
  else if (phase === "settled") await phaseSettled();
  else throw new Error("--phase trade|settled");
  console.log(`\nphase ${phase}: PASS`);
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error(`\nFAIL: ${(e as Error).message}`);
  process.exit(1);
});
