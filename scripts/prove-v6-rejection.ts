// After finalized close, submit one Devnet take against the preserved, funded YES sell.
// Keep the maker and keeper from touching the order until the proof and balance reads finish.
// pnpm tsx scripts/prove-v6-rejection.ts --order <address> [--submit]
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { unpackAccount } from "@solana/spl-token";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { findEscrowPda, OrderSide, Outcome, quote } from "@metrex/exchange";
import {
  ataOf, explorerTx, fetchExchangeConfig, fetchExchangeMarket, fetchRound, getExchangeProgram, getRpc,
  loadKeypair, parseTxEvents, takeOrderIx, toOrderAccount,
} from "@metrex/server/exchange";
import { args, flagValue } from "./lib/common";
import { DEVNET_GENESIS } from "./lib/v2";

async function main(): Promise<void> {
  const address = flagValue("--order");
  assert(address, "Pass the preserved order address with --order");
  const orderKey = new PublicKey(address);
  const conn = getRpc().connection;
  assert.equal(await conn.getGenesisHash(), DEVNET_GENESIS, "This proof requires Solana Devnet");
  const program = getExchangeProgram(conn);
  const raw = await program.account.order.fetchNullable(orderKey, "finalized");
  assert(raw, "The preserved order account is missing");
  const order = toOrderAccount(orderKey, raw);
  assert(order.side === OrderSide.Sell && order.outcome === Outcome.Yes && order.remainingQty > 0n, "Expected a resting YES sell");
  const [config, market] = await Promise.all([
    fetchExchangeConfig(program, "finalized"),
    fetchExchangeMarket(program, new PublicKey(order.market), "finalized"),
  ]);
  assert(config && market?.propertyId === 1, "Expected the featured market");
  const round = await fetchRound(program, market.round, "finalized");
  assert(round, "Round missing");
  const botA = loadKeypair("botA");
  const taker = order.maker === botA.publicKey.toBase58() ? loadKeypair("botB") : botA;
  const escrow = findEscrowPda(program.programId, orderKey)[0];
  const tokenAccounts = [
    { label: "escrow YES", key: escrow, mint: market.yesMint, owner: orderKey },
    { label: "maker mUSD", key: ataOf(config.collateralMint, new PublicKey(order.maker)), mint: config.collateralMint, owner: new PublicKey(order.maker) },
    { label: "taker mUSD", key: ataOf(config.collateralMint, taker.publicKey), mint: config.collateralMint, owner: taker.publicKey },
    { label: "taker YES", key: ataOf(market.yesMint, taker.publicKey), mint: market.yesMint, owner: taker.publicKey },
  ];
  const keys = [orderKey, ...tokenAccounts.map(({ key }) => key)];
  const before = await conn.getMultipleAccountsInfo(keys, "finalized");
  assert(before[0]?.owner.equals(program.programId), "Order disappeared before the snapshot");
  const amounts = tokenAccounts.map(({ key, mint, owner, label }, i) => {
    const account = unpackAccount(key, before[i + 1]);
    assert(account.mint.equals(mint) && account.owner.equals(owner), `${label} has incorrect mint or owner`);
    return account.amount;
  });
  assert(amounts[0] >= order.remainingQty, "Resting YES sell is underfunded");
  assert(amounts[2] >= quote(1n, order.priceBps), "Taker cannot fund one share at the resting price");
  console.log(`Round ${round.roundId} ${round.status}, order ${address}, seq ${order.seq}, ${order.remainingQty} YES resting @ ${order.priceBps} bps`);
  console.log("Before, base units:", tokenAccounts.map(({ label }, i) => `${label}=${amounts[i]}`).join(", "));
  if (!args.includes("--submit")) return;

  assert.equal(round.status, "closed", "Wait for finalized closure before submitting the proof");
  const ix = await takeOrderIx(program, market, taker.publicKey, config.collateralMint, order, 1n, order.priceBps);
  const blockhash = await conn.getLatestBlockhash("finalized");
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: taker.publicKey, recentBlockhash: blockhash.blockhash, instructions: [ix],
  }).compileToV0Message());
  tx.sign([taker]);
  // Preflight would reject this before it could land and produce transaction evidence.
  const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  console.log(explorerTx(signature));
  // A failed transaction can still finalize. Read its finalized metadata directly instead of
  // relying on a confirmation subscription that can report the failure as a rejected promise.
  const readFinalized = () => conn.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 });
  let result = await readFinalized();
  const deadline = Date.now() + 45_000;
  while (!result && Date.now() < deadline) {
    await delay(1_000);
    result = await readFinalized();
  }
  assert(result?.meta, "Finalized transaction metadata unavailable");
  const logs = result.meta.logMessages ?? [];
  console.log(logs.join("\n"));
  assert.deepEqual(result.meta.err, { InstructionError: [0, { Custom: 6012 }] });
  assert(logs.some((line) => line.includes("Error Code: RoundNotOpen")), "Expected RoundNotOpen in program logs");
  const events = parseTxEvents(program, { signature, slot: result.slot, blockTime: result.blockTime ?? null, logs });
  assert(!events.some(({ name }) => name === "OrderFilled"), "Unexpected fill event");
  assert.deepEqual(await conn.getMultipleAccountsInfo(keys, "finalized"), before, "Order or token accounts changed");
  assert.deepEqual(result.meta.postBalances.map((balance, i) => result.meta!.preBalances[i] - balance),
    result.meta.preBalances.map((_, i) => i === 0 ? result.meta!.fee : 0));
  console.log(`After, base units: ${tokenAccounts.map(({ label }, i) => `${label}=${amounts[i]}`).join(", ")}`);
  console.log(`Finalized slot ${result.slot}. No fill. Order, escrow, and token accounts unchanged. Fee: ${result.meta.fee} lamports.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
