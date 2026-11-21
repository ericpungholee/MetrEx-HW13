// Real Devnet rehearsal with disposable signers and the running production app.
// Set DEMO_PASSWORD, RPC_URL and METREX_APP_ORIGIN. Use --hazard to limit settlement scope.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { CATALOG, OrderSide, Outcome, PAYOUT_PER_SHARE, findEscrowPda, quote, randomNonce, type OutcomeCode } from "@metrex/exchange";
import {
  ExchangeStateLoader, ataOf, cancelOrderIx, createAtaIdempotentIx, explorerTx,
  fetchExchangeMarket, fetchOrders, fetchRound, getExchangeProgram, getRpc, mergeIx,
  placeOrderIx, redeemIx, sendExchangeTx, splitIx, takeOrderIx, tokenBalance, toOrderAccount,
  type MarketBookSnapshot,
} from "@metrex/server/exchange";
import { DEVNET_GENESIS } from "./lib/v2";
import { args, flagValue } from "./lib/common";

async function main(): Promise<void> {
  const rpc = getRpc();
  const conn = rpc.connection;
  const program = getExchangeProgram(conn);
  assert.equal(await rpc.run((c) => c.getGenesisHash()), DEVNET_GENESIS, "Devnet required");
  const root = process.env.METREX_APP_ORIGIN ?? "http://127.0.0.1:3015";
  const password = process.env.DEMO_PASSWORD;
  assert(password, "Set DEMO_PASSWORD");
  const json = async (path: string, body?: object) => {
    const r = await fetch(new URL(path, root), body ? {
      method: "POST", headers: { "content-type": "application/json", "x-demo-password": password }, body: JSON.stringify(body),
    } : undefined);
    const result = await r.json();
    assert(r.ok, `${path}: ${r.status} ${JSON.stringify(result)}`);
    return result;
  };
  const hazard = flagValue("--hazard");
  const targets = CATALOG.filter((c) => !hazard || c.hazard === hazard);
  assert(targets.length, "Unknown hazard");
  const loader = new ExchangeStateLoader();
  const initial = await rpc.run((c) => loader.load(c));
  assert(initial, "Exchange Config missing");
  const usd = initial.config.collateralMint;
  const selected = targets.map((c) => {
    const snap = [...initial.snapshots].reverse().find((s) => s.market.propertyId === c.propertyId && s.tradingOpen);
    assert(snap, `${c.hazard}: no open catalog market`);
    return { hazard: c.hazard, snap };
  });
  const remaining = new Set(initial.snapshots.filter((s) => s.tradingOpen).map((s) => s.round.address.toBase58()));

  for (const { snap, hazard: kind } of selected) {
    const m = snap.market;
    const market = m.address.toBase58();
    const round = m.round.toBase58();
    const signer = Keypair.generate();
    const owner = signer.publicKey;
    const usdAta = ataOf(usd, owner);
    const sideAta = (side: OutcomeCode) => ataOf(side === Outcome.Yes ? m.yesMint : m.noMint, owner);
    const balance = (address: PublicKey) => rpc.run((c) => tokenBalance(c, address));
    const record = (action: string, info: object) => console.log(JSON.stringify({ hazard: kind, market, round, action, ...info }));
    const send = async (action: string, ixs: TransactionInstruction[]) => {
      const signature = await sendExchangeTx(rpc.connection, ixs, [signer]);
      record(action, { signature, explorer: explorerTx(signature) });
      return signature;
    };
    const funds = await json("/api/faucet", { wallet: owner.toBase58() });
    assert.equal(await balance(usdAta), BigInt(funds.musdBaseUnits), "Faucet grant didn't reach the wallet");
    record("faucet", { ...funds, solLamportsAfter: await conn.getBalance(owner) });
    if (args.includes("--verify-replenishment")) {
      const health = await json("/api/health") as { marketMakers: { address: string }[] };
      const makers = new Set(health.marketMakers.map((x) => x.address));
      const best = snap.book.filter((o) => o.outcome === Outcome.No && o.side === OrderSide.Sell && makers.has(o.maker))
        .sort((a, b) => a.priceBps - b.priceBps)[0];
      assert(best && best.remaining >= 10n);
      const resting = snap.orders.find((o) => o.address === best.id)!;
      const quantity = (resting.remainingQty + 9n) / 10n;
      const before = await balance(usdAta);
      await send("take-for-replenishment", [
        createAtaIdempotentIx(owner, owner, m.noMint),
        await takeOrderIx(program, m, owner, usd, resting, quantity, resting.priceBps),
      ]);
      assert.equal(before - await balance(usdAta), quote(quantity, resting.priceBps));
      assert.equal(await balance(sideAta(Outcome.No)), quantity);
      for (let i = 0; i < 20; i++) {
        const orders = await rpc.run((c) => fetchOrders(getExchangeProgram(c), { market: m.address, maker: new PublicKey(resting.maker) }));
        const replacement = orders.find((o) => o.outcome === Outcome.No && o.side === OrderSide.Sell &&
          o.address !== resting.address && o.remainingQty >= resting.remainingQty);
        if (replacement) {
          assert.equal(orders.some((o) => o.address === resting.address), false);
          record("replenished", {
            maker: resting.maker, filled: quantity.toString(), oldOrder: resting.address,
            newOrder: replacement.address, restoredDepth: replacement.remainingQty.toString(), priceBps: replacement.priceBps,
          });
          break;
        }
        if (i === 19) throw new Error("Maker did not replenish within the observation window");
        await delay(1_000);
      }
      continue;
    }
    const beforeSplit = await balance(usdAta);
    const beforeVault = await balance(m.vault);
    const beforeMarket = await fetchExchangeMarket(program, m.address);
    assert(beforeMarket);
    await send("split", [
      createAtaIdempotentIx(owner, owner, m.yesMint),
      createAtaIdempotentIx(owner, owner, m.noMint),
      await splitIx(program, m, owner, usd, 3n),
    ]);
    assert.equal(await balance(usdAta), beforeSplit - 3n * PAYOUT_PER_SHARE);
    assert.equal(await balance(m.vault), beforeVault + 3n * PAYOUT_PER_SHARE);
    assert.equal((await fetchExchangeMarket(program, m.address))?.pairsOutstanding, beforeMarket.pairsOutstanding + 3n);
    await send("merge", [await mergeIx(program, m, owner, usd, 3n)]);
    assert.equal(await balance(m.vault), beforeVault);
    assert.equal(await balance(usdAta), beforeSplit);
    assert.equal((await fetchExchangeMarket(program, m.address))?.pairsOutstanding, beforeMarket.pairsOutstanding);

    const book = async (): Promise<MarketBookSnapshot> => {
      const state = await rpc.run((c) => loader.load(c));
      const current = state?.snapshots.find((s) => s.market.address.equals(m.address));
      assert(current?.tradingOpen);
      return current;
    };
    const take = async (side: OutcomeCode, buying: boolean) => {
      const fresh = await book();
      const active = fresh.book.filter((o) => o.outcome === side && o.side === (buying ? OrderSide.Sell : OrderSide.Buy));
      const match = active.sort((a, b) => buying ? a.priceBps - b.priceBps : b.priceBps - a.priceBps)[0];
      assert(match && match.remaining > 10n, "Expected a funded resting order for a partial fill");
      const order = fresh.orders.find((o) => o.address === match.id)!;
      const changes = await Promise.all([balance(usdAta), balance(sideAta(side))]);
      const q = buying ? 4n : 1n;
      const cost = quote(q, order.priceBps);
      await send(`${buying ? "buy" : "sell"}-${side === Outcome.Yes ? "yes" : "no"}`, [
        await takeOrderIx(program, m, owner, usd, order, q, order.priceBps),
      ]);
      assert.deepEqual(await Promise.all([balance(usdAta), balance(sideAta(side))]), buying
        ? [changes[0]! - cost, changes[1]! + q] : [changes[0]! + cost, changes[1]! - q]);
      const onChain = await program.account.order.fetch(new PublicKey(match.id), "confirmed");
      assert.equal(toOrderAccount(new PublicKey(match.id), onChain).remainingQty, order.remainingQty - q);
      const escrow = findEscrowPda(program.programId, new PublicKey(match.id))[0];
      const obligation = order.remainingQty - q;
      assert(await balance(escrow) >= (buying ? obligation : quote(obligation, order.priceBps)));
      record("partial-fill-and-escrow", { priceBps: order.priceBps, quantity: q.toString(), quote: cost.toString() });
    };
    for (const outcome of [Outcome.Yes, Outcome.No] as const) {
      await take(outcome, true);
      await take(outcome, false);
    }

    const limit = await placeOrderIx(program, m, owner, usd, {
      clientNonce: randomNonce(), outcome: Outcome.Yes, side: OrderSide.Buy, priceBps: 1, quantity: 2n,
    });
    const beforeLimit = await balance(usdAta);
    await send("place-1-bps-limit", [limit.ix]);
    assert.equal(await balance(usdAta), beforeLimit - 200n);
    assert.equal(await balance(findEscrowPda(program.programId, limit.order)[0]), 200n);
    const resting = toOrderAccount(limit.order, await program.account.order.fetch(limit.order, "confirmed"));
    await send("cancel-limit", [await cancelOrderIx(program, m, owner, usd, resting)]);
    assert.equal(await balance(usdAta), beforeLimit);
    assert.equal(await conn.getAccountInfo(limit.order, "confirmed"), null);

    const hidden = await fetch(new URL(`/api/evidence/${market}`, root));
    assert(!hidden.ok, "Evidence was visible before settlement");
    for (const action of ["close", "reject", "resolve", "sweep", "status"]) {
      const result = await json("/api/operator/settle-round", { round, action });
      record(action, { result });
      if (action === "close") {
        remaining.delete(round);
        for (const other of remaining) {
          assert.equal((await fetchRound(program, new PublicKey(other), "finalized"))?.status, "open");
        }
      }
      if (action === "reject") assert(result.roundNotOpen && result.signature, "Missing real rejection receipt");
    }
    const marketAfter = await fetchExchangeMarket(program, m.address, "finalized");
    assert(marketAfter && (marketAfter.outcome === "yes" || marketAfter.outcome === "no"));
    const evidence = await json(`/api/evidence/${market}`);
    const hash = createHash("sha256").update(evidence.canonical).digest("hex");
    assert.equal(hash, Buffer.from(marketAfter.evidenceHash).toString("hex"));
    assert.equal(evidence.record.triggered, marketAfter.outcome === "yes");
    const winning = marketAfter.outcome === "yes" ? Outcome.Yes : Outcome.No;
    const quantity = await balance(sideAta(winning));
    assert.equal(quantity, 3n);
    const before = await balance(usdAta);
    await send("redeem", [await redeemIx(program, m, owner, usd, winning, quantity)]);
    const after = await balance(usdAta);
    assert.equal(after - before, quantity * PAYOUT_PER_SHARE);
    assert.equal(await balance(sideAta(winning)), 0n);
    record("verified", { evidenceHash: hash, outcome: marketAfter.outcome, mUSDBefore: before.toString(), mUSDAfter: after.toString() });
    await delay(1_000);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
