// Isolated Devnet test, run after the tornado rehearsal and before creating demo-ready rounds.
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { catalogByProperty, findRoundPda, INVALID_PAYOUT_PER_SHARE, marketAddresses, Outcome, PAYOUT_PER_SHARE } from "@metrex/exchange";
import { encodeLabel, type ScenarioRegistry } from "@metrex/shared";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "@metrex/server";
import {
  ataOf, chainNow, closeRoundIx, createAtaIdempotentIx, createMarketIx, createRoundIx,
  explorerTx, fetchAllRounds, fetchExchangeConfig, fetchExchangeMarket, getExchangeProgram, getRpc,
  loadKeypair, redeemIx, sendExchangeTx, splitIx, tokenBalance,
} from "@metrex/server/exchange";
import { holdClosure, releaseClosure } from "../packages/server/src/exchange/closure-hold";
import { DEVNET_GENESIS } from "./lib/v2";

async function main() {
  const rpc = getRpc();
  const conn = rpc.connection;
  const p = getExchangeProgram(conn);
  assert.equal(await conn.getGenesisHash(), DEVNET_GENESIS);
  const catalog = catalogByProperty(6)!;
  const config = await fetchExchangeConfig(p, "finalized");
  assert(config);
  const rounds = await fetchAllRounds(p);
  assert(!rounds.some((r) => r.status === "open" && r.scenarioId === catalog.scenarioId), "Finish the live tornado replay first.");
  const controller = loadKeypair("controller");
  const admin = loadKeypair("admin");
  const oracle = loadKeypair("oracle");
  const round = findRoundPda(p.programId, config.nextRoundId)[0];
  const data = JSON.parse(readFileSync(join(dataDir(), "scenarios.json"), "utf8")) as ScenarioRegistry;
  const scenario = data[String(catalog.scenarioId)]!;
  const { market } = marketAddresses(p.programId, round, catalog.propertyId);
  const usd = config.collateralMint;
  const signer = Keypair.generate();
  const owner = signer.publicKey;
  const log = (step: string, sig: string) => console.log(JSON.stringify({ step, round: round.toBase58(), market: market.toBase58(), sig, explorer: explorerTx(sig) }));
  const opts = { commitment: "finalized" as const };
  holdClosure(round);
  try {
    log("create-round", await sendExchangeTx(conn, [await createRoundIx(p, {
      roundController: controller.publicKey, roundId: config.nextRoundId, previousRound: null,
      scenarioId: catalog.scenarioId, datasetSha256: [...Buffer.from(scenario.sha256, "hex")],
      label: encodeLabel("Tornado isolated Invalid proof"),
      tradingEndsAt: await chainNow(conn) + 1_800n,
    })], [controller], opts));
    log("create-market", await sendExchangeTx(conn, [await createMarketIx(p, {
      roundController: controller.publicKey, round, propertyId: catalog.propertyId, collateralMint: usd,
    })], [controller], opts));
    const m = await fetchExchangeMarket(p, market, "finalized");
    assert(m);
    const origin = process.env.METREX_APP_ORIGIN ?? "http://127.0.0.1:3015";
    const grant = await fetch(new URL("/api/faucet", origin), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet: owner.toBase58() }),
    });
    assert(grant.ok, `Faucet failed (${grant.status})`);
    const funds = await grant.json();
    log("faucet", String(funds.signature));
    const cash = ataOf(usd, owner);
    const balance = (a: typeof cash) => tokenBalance(conn, a, "finalized");
    const starting = BigInt(funds.musdBaseUnits as string);
    assert.equal(await tokenBalance(conn, cash), starting);
    log("split", await sendExchangeTx(conn, [
      createAtaIdempotentIx(owner, owner, m.yesMint), createAtaIdempotentIx(owner, owner, m.noMint),
      await splitIx(p, m, owner, usd, 2n),
    ], [signer], opts));
    assert.equal(await balance(m.vault), 2n * PAYOUT_PER_SHARE);
    log("close", await sendExchangeTx(conn, [await closeRoundIx(p, controller.publicKey, round)], [controller], opts));
    log("invalidate", await sendExchangeTx(conn, [await p.methods.invalidateMarket(1).accountsStrict({
      config: config.address, round, market, admin: admin.publicKey, oracleAuthority: oracle.publicKey,
    }).instruction()], [admin, oracle], opts));
    assert.equal((await fetchExchangeMarket(p, market, "finalized"))?.outcome, "invalid");
    for (const side of [Outcome.Yes, Outcome.No] as const) {
      const before = await balance(cash);
      log(side === Outcome.Yes ? "redeem-yes" : "redeem-no", await sendExchangeTx(conn,
        [await redeemIx(p, m, owner, usd, side, 2n)], [signer], opts));
      assert.equal(await balance(cash) - before, 2n * INVALID_PAYOUT_PER_SHARE);
    }
    assert.equal(await balance(cash), starting);
    assert.equal(await balance(m.vault), 0n);
    console.log(JSON.stringify({ step: "verified", mUSDBefore: starting.toString(), mUSDAfter: (await balance(cash)).toString(), vaultAfter: "0" }));
  } finally {
    releaseClosure(round);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
