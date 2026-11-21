// Verify the first Devnet lifecycle or the two bot-driven market outcomes through the app client.
//   pnpm tsx scripts/prove-lifecycle.ts --manual
//   pnpm tsx scripts/prove-lifecycle.ts
// Add --local for a disposable validator. Run the app and, in bot mode, the bot worker first.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { verifyEvidenceText } from "@metrex/geo";
import { KeypairWallet, explorerAddress, explorerTx, loadKeypair, requireEnv } from "@metrex/server";
import { MUSD_UNIT, marketStatusOf, offerStatusOf } from "@metrex/shared";
import { Keypair } from "@solana/web3.js";
import {
  acceptOffers, claimAll, claimablePositions, createMarket, fetchMarket, fetchMusdBalance,
  fetchOffersByMarket, getConnection, placeOffer,
} from "../app/lib/client";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const local = process.argv.includes("--local");
const manual = process.argv.includes("--manual");
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

  for (const propertyId of manual ? [1] : [1, 2]) {
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
    for (const offer of offers) console.log(`Offer ${local ? offer.publicKey.toBase58() : explorerAddress(offer.publicKey)}`);

    const accepted = await acceptOffers(homeowner, market, offers);
    assert.equal(accepted.length, 1, "Accept all must fit in one transaction");
    tx("Coverage accepted", accepted[0]!.signature);

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
    for (const winner of triggered ? [homeowner] : bots) {
      const positions = claimablePositions(winner.publicKey, [resolved], offers);
      assert.equal(positions.length, triggered && !manual ? 3 : 1);
      const before = await fetchMusdBalance(winner.publicKey);
      const claims = await claimAll(winner, positions);
      assert.equal(claims.length, 1, "Claims for each wallet must fit in one transaction");
      tx("Payout claimed", claims[0]!.signature);
      paid += await fetchMusdBalance(winner.publicKey) - before;
    }
    assert.equal(paid, coverage);
    const finalOffers = await fetchOffersByMarket(market);
    assert(finalOffers.every(({ account }) => offerStatusOf(account.status) === "claimed"));
    console.log(`${label} complete. 10,000 mUSD paid. Evidence SHA-256 ${hashHex}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
