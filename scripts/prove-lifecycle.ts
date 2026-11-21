// Verify the first Devnet lifecycle or the two bot-driven market outcomes through the app client.
//   pnpm tsx scripts/prove-lifecycle.ts --manual
//   pnpm tsx scripts/prove-lifecycle.ts
// Add --local for a disposable validator. Run the app and, in bot mode, the bot worker first.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { verifyEvidenceText } from "@metrex/geo";
import { KeypairWallet, explorerAddress, explorerTx, loadKeypair, requireEnv } from "@metrex/server";
import { MUSD_UNIT, Side, marketStatusOf, offerStatusOf } from "@metrex/shared";
import { Keypair } from "@solana/web3.js";
import {
  acceptOffers, buyPosition, cancelOffer, claimAll, claimablePositions, createMarket, fetchListingsForOffers, fetchMarket, fetchMusdBalance,
  fetchOffersByMarket, getConnection, placeOffer,
} from "../app/lib/client";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const local = process.argv.includes("--local");
const manual = process.argv.includes("--manual");
const trading = process.argv.includes("--tier2");
const app = new URL(process.env.METREX_APP_ORIGIN ?? "http://127.0.0.1:3000");

function isLoopback(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function tx(label: string, signature: string): void {
  console.log(`${label} ${local ? signature : explorerTx(signature)}`);
}

async function post(path: string, headers: Record<string, string>): Promise<Response> {
  const response = await fetch(new URL(path, app), { method: "POST", headers });
  assert(response.ok, `${path} returned HTTP ${response.status}`);
  return response;
}

async function main(): Promise<void> {
  assert(!(manual && trading), "Choose either --manual or --tier2");
  const conn = getConnection();
  assert(isLoopback(app), "Run the demonstration API on a loopback address");
  if (local) assert(isLoopback(new URL(conn.rpcEndpoint)), "--local requires a loopback RPC");
  else assert.equal(await conn.getGenesisHash(), DEVNET_GENESIS, "The app RPC must be Solana Devnet");

  const headers = { "x-demo-password": requireEnv("DEMO_PASSWORD") };
  const homeowner = new KeypairWallet(loadKeypair("homeownerDemo"));
  const judge = new KeypairWallet(loadKeypair("judge1"));
  const bots = (["botA", "botB", "botC"] as const).map((role) => new KeypairWallet(loadKeypair(role)));

  if (!manual) {
    const wallet = Keypair.generate().publicKey;
    const response = await fetch(new URL("/api/faucet", app), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: wallet.toBase58() }),
    });
    assert(response.ok, `Faucet returned HTTP ${response.status}`);
    const payout = await response.json() as { signature: string };
    assert.equal(await fetchMusdBalance(wallet), 25_000n * MUSD_UNIT);
    assert.equal(await conn.getBalance(wallet, "confirmed"), 50_000_000);
    tx("Fresh wallet funded by faucet", payout.signature);
  }

  for (const propertyId of manual ? [1] : trading ? [2] : [1, 2]) {
    const triggered = propertyId === 1;
    const label = triggered ? "YES" : "NO";
    const coverage = 10_000n * MUSD_UNIT;
    const created = await createMarket(homeowner, propertyId, coverage);
    const market = created.market;
    console.log(`${label} market ${local ? market.toBase58() : explorerAddress(market)}`);
    tx("Market created", created.results[0]!.signature);

    const openedAt = Date.now();
    if (manual) tx("Judge offer", (await placeOffer(judge, market, coverage, 400)).results[0]!.signature);

    let offers = await fetchOffersByMarket(market);
    while (!manual && offers.length < 3 && Date.now() - openedAt < 10_000) {
      await delay(300);
      offers = await fetchOffersByMarket(market);
    }
    assert.equal(offers.length, manual ? 1 : 3);
    if (!manual) {
      assert.deepEqual(offers.map(({ account }) => account.premiumBps).sort((a, b) => a - b), [400, 450, 500]);
      console.log(`Three bot offers observed in ${Date.now() - openedAt} ms`);
    }
    if (trading) {
      const undercut = await placeOffer(judge, market, 2_000n * MUSD_UNIT, 390);
      tx("Judge undercut", undercut.results[0]!.signature);
      const expectedRates = [380, 400, 450];
      const deadline = Date.now() + 20_000;
      for (;;) {
        const current = (await fetchOffersByMarket(market))
          .filter(({ account }) => offerStatusOf(account.status) === "open");
        offers = current.filter(({ account }) => bots.some((bot) => bot.publicKey.equals(account.underwriter)));
        const rates = offers.map(({ account }) => account.premiumBps).sort((left, right) => left - right);
        if (rates.join() === expectedRates.join()) {
          const testOffer = current.find(({ publicKey }) => publicKey.equals(undercut.offer));
          assert(testOffer);
          await cancelOffer(judge, testOffer);
          console.log(`Bots requoted to ${rates.join(", ")} bps`);
          break;
        }
        assert(Date.now() < deadline, `Bot requotes did not reach ${expectedRates.join(", ")} bps`);
        await delay(300);
      }
    }
    for (const offer of offers) console.log(`Offer ${local ? offer.publicKey.toBase58() : explorerAddress(offer.publicKey)}`);

    const acceptedKeys = new Set(offers.map(({ publicKey }) => publicKey.toBase58()));
    const accepted = await acceptOffers(homeowner, market, offers);
    assert.equal(accepted.length, 1, "Accept all must fit in one transaction");
    tx("Coverage accepted", accepted[0]!.signature);

    let tradedOffer = "";
    if (trading) {
      const offerKeys = offers.map(({ publicKey }) => publicKey);
      const deadline = Date.now() + 15_000;
      for (;;) {
        const listings = await fetchListingsForOffers(offerKeys);
        const listing = listings.find(({ account }) => account.side === Side.Risk);
        if (listing) {
          const offer = offers.find(({ publicKey }) => publicKey.equals(listing.account.offer));
          assert(offer);
          const before = await fetchMusdBalance(judge.publicKey);
          const [trade] = await buyPosition(judge, listing, offer);
          assert(trade);
          tx("Judge bought Risk position", trade.signature);
          assert.equal(before - await fetchMusdBalance(judge.publicKey), BigInt(listing.account.price.toString()));
          const updated = (await fetchOffersByMarket(market)).find(({ publicKey }) => publicKey.equals(offer.publicKey));
          assert(updated?.account.riskHolder.equals(judge.publicKey));
          tradedOffer = offer.publicKey.toBase58();
          break;
        }
        assert(Date.now() < deadline, "No Risk position listing appeared");
        await delay(300);
      }
    }

    for (const route of ["demo/close", "oracle/resolve"]) {
      const response = await post(`/api/${route}/${market}`, headers);
      tx(route, (await response.json() as { signature: string }).signature);
    }

    const response = await fetch(new URL(`/api/evidence/${market}?raw=1`, app));
    assert(response.ok, "Evidence endpoint should serve the canonical record");
    const evidence = await response.text();
    const { hashHex, isCanonical } = verifyEvidenceText(evidence);
    assert(isCanonical);
    assert.equal(JSON.parse(evidence).triggered, triggered);

    const resolved = await fetchMarket(market);
    assert(resolved);
    assert.equal(marketStatusOf(resolved.account.status), triggered ? "resolvedYes" : "resolvedNo");
    assert.equal(resolved.account.coverageActivated.toString(), coverage.toString());
    assert.equal(Buffer.from(resolved.account.evidenceHash).toString("hex"), hashHex);
    offers = await fetchOffersByMarket(market);
    let paid = 0n;
    for (const winner of triggered ? [homeowner] : trading ? [...bots, judge] : bots) {
      const positions = claimablePositions(winner.publicKey, [resolved], offers);
      if (trading && !positions.length && !winner.publicKey.equals(judge.publicKey)) continue;
      assert.equal(positions.length, triggered && !manual ? 3 : 1);
      if (trading && winner.publicKey.equals(judge.publicKey)) {
        assert.equal(positions[0]!.offer.publicKey.toBase58(), tradedOffer);
      }
      const before = await fetchMusdBalance(winner.publicKey);
      const claims = await claimAll(winner, positions);
      assert.equal(claims.length, 1, "Claims for each wallet must fit in one transaction");
      tx("Payout claimed", claims[0]!.signature);
      paid += await fetchMusdBalance(winner.publicKey) - before;
    }
    assert.equal(paid, coverage);
    const finalOffers = (await fetchOffersByMarket(market))
      .filter(({ publicKey }) => acceptedKeys.has(publicKey.toBase58()));
    assert.equal(finalOffers.length, acceptedKeys.size);
    assert(finalOffers.every(({ account }) => offerStatusOf(account.status) === "claimed"));
    console.log(`${label} complete. 10,000 mUSD paid. Evidence SHA-256 ${hashHex}`);
  }
  if (trading) {
    const response = await fetch(new URL("/api/stats", app));
    assert(response.ok);
    const stats = await response.json() as { txTotal: number; txLast10Min: number; totalFeesLamports: string };
    assert(stats.txTotal > 0 && stats.txLast10Min > 0);
    assert(BigInt(stats.totalFeesLamports) > 0n);
    console.log(`Network panel counted ${stats.txTotal} transactions, ${stats.txLast10Min} recent transactions and ${stats.totalFeesLamports} lamports.`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
