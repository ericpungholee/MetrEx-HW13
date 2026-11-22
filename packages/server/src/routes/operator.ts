// POST /api/operator/settle-round (spec-v2 §10.6). The Close and settle workflow, one step per
// request so the operator page shows each verifiable transaction as it lands. Every step reads the
// chain first and skips what is already done, so the workflow can be resumed from any point.
// No authentication (Phantom is the only sign-in). Keys stay on the server.

import { setTimeout as delay } from "node:timers/promises";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ERROR_CODE_OFFSET, ERROR_NAMES, OrderSide, type OrderAccount } from "@metrex/exchange";
import { ataOf, tokenBalance, fetchExchangeConfig, fetchMarketsOfRound, fetchOrders, fetchRound, type RoundView } from "../exchange/accounts";
import { closeRoundIx, takeOrderIx } from "../exchange/ix";
import { holdClosure, releaseClosure } from "../exchange/closure-hold";
import { getExchangeProgram } from "../exchange/program";
import { sendExchangeTx } from "../exchange";
import { loadKeypair, parsePublicKey, type KeypairName } from "../env";
import { explorerTx } from "../explorer";
import { settleRound, type SettleStep } from "../oracle/exchange-settle";
import { closeAndResolve, waitFinalizedClosed } from "../demo/lifecycle";
import { operationRunning } from "../demo/operations";
import { fullResetHeld } from "../exchange/demo-state";
import { getRpc } from "../rpc";
import { badRequest, conflict, HttpError, KeyedLock, notFound, unavailable } from "./errors";
import { json } from "./http";

export const OPERATOR_ACTIONS = ["status", "close", "reject", "resolve", "sweep", "fast_forward"] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

const BOT_KEYS: readonly KeypairName[] = ["botA", "botB", "botC"];
const lock = new KeyedLock();

const withLinks = (steps: SettleStep[]) => steps.map((s) => ({ ...s, explorer: s.signature ? explorerTx(s.signature) : null }));

/**
 * Market-page settlement (docs/spec-simulation.md §7.1): close_round stops every member market of
 * the round, so a request naming one market is refused unless that market is the round's only
 * member. Pure so it can be tested without a cluster.
 */
export function soleMarketError(market: string, roundAddress: string, members: readonly { address: string; round: string }[]): string | null {
  const target = members.find((m) => m.address === market);
  if (!target || target.round !== roundAddress) return "Market does not belong to this round";
  if (members.length !== 1) return `This round has ${members.length} markets, so it cannot be settled one market at a time`;
  return null;
}

async function requireSoleMarket(round: RoundView, market: unknown): Promise<void> {
  if (market === undefined) return;
  if (typeof market !== "string" || !market) throw badRequest("Invalid market address");
  try {
    parsePublicKey(market, "market");
  } catch {
    throw badRequest("Invalid market address");
  }
  const members = await getRpc().run((c) => fetchMarketsOfRound(getExchangeProgram(c), round.address));
  const err = soleMarketError(market, round.address.toBase58(), members.map((m) => ({ address: m.address.toBase58(), round: m.round.toBase58() })));
  if (err) throw conflict(err);
}

async function targetRound(body: { round?: unknown }): Promise<RoundView> {
  const rpc = getRpc();
  if (typeof body.round !== "string" || !body.round) throw badRequest("Select a round");
  let address: PublicKey;
  try {
    address = parsePublicKey(body.round, "round");
  } catch {
    throw badRequest("Invalid round address");
  }
  const round = await rpc.run((c) => fetchRound(getExchangeProgram(c), address, "finalized"));
  if (!round) throw notFound("Round not found");
  return round;
}

/** §10.6 step 6: resolved_count == market_count and no orders remain. */
async function status(round: RoundView) {
  const rpc = getRpc();
  const markets = await rpc.run((c) => fetchMarketsOfRound(getExchangeProgram(c), round.address));
  const rows = await Promise.all(
    markets.map(async (m) => ({
      address: m.address.toBase58(),
      propertyId: m.propertyId,
      outcome: m.outcome,
      evidenceHash: Buffer.from(m.evidenceHash).toString("hex"),
      orders: (await rpc.run((c) => fetchOrders(getExchangeProgram(c), { market: m.address }))).length,
    })),
  );
  return {
    round: round.address.toBase58(),
    roundId: round.roundId.toString(),
    status: round.status,
    marketCount: round.marketCount,
    resolvedCount: round.resolvedCount,
    markets: rows,
    complete: round.status === "closed" && round.resolvedCount === round.marketCount && rows.every((r) => r.orders === 0),
  };
}

/** Submit a signed take with preflight bypassed and verify its finalized rejection receipt. */
async function proveRejected(round: RoundView) {
  const rpc = getRpc();
  const conn = rpc.connection;
  const p = getExchangeProgram(conn);
  const config = await fetchExchangeConfig(p, "finalized");
  if (!config) throw unavailable("Exchange is not configured on this cluster");
  const markets = await fetchMarketsOfRound(p, round.address);
  const bots = BOT_KEYS.map((k) => loadKeypair(k));
  for (const m of markets) {
    const orders = await fetchOrders(p, { market: m.address });
    const order: OrderAccount | undefined = orders.find((o) => o.side === OrderSide.Sell && o.remainingQty > 0n);
    if (!order) continue;
    const taker = bots.find((b) => b.publicKey.toBase58() !== order.maker);
    if (!taker) continue;
    const mint = order.outcome === 0 ? m.yesMint : m.noMint;
    const receive = ataOf(mint, taker.publicKey);
    if (!(await conn.getAccountInfo(receive, "finalized"))) continue;
    const collateral = ataOf(config.collateralMint, taker.publicKey);
    if (await tokenBalance(conn, collateral) < BigInt(order.priceBps) * 100n) continue;
    const ix = await takeOrderIx(p, m, taker.publicKey, config.collateralMint, order, 1n, order.priceBps);
    const { blockhash } = await conn.getLatestBlockhash("finalized");
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: taker.publicKey, recentBlockhash: blockhash, instructions: [ix],
    }).compileToV0Message());
    tx.sign([taker]);
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const receipt = await rpc.run((c) => c.getTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }));
      const meta = receipt?.meta;
      if (!meta) {
        await delay(1_000);
        continue;
      }
      const err = meta.err as { InstructionError?: [number, { Custom?: number }] } | null;
      const code = ERROR_CODE_OFFSET + ERROR_NAMES.indexOf("RoundNotOpen");
      const roundNotOpen = err?.InstructionError?.[0] === 0 && err.InstructionError[1]?.Custom === code;
      const lamportsUnchanged = meta.preBalances.every((value, i) => value - meta.postBalances[i]! === (i === 0 ? meta.fee : 0));
      const tokenAmounts = (balances: typeof meta.preTokenBalances) => (balances ?? []).map((b) => [b.accountIndex, b.uiTokenAmount.amount]).sort();
      const tokensUnchanged = JSON.stringify(tokenAmounts(meta.preTokenBalances)) === JSON.stringify(tokenAmounts(meta.postTokenBalances));
      if (!roundNotOpen || !lamportsUnchanged || !tokensUnchanged) {
        throw conflict(`The finalized receipt did not verify closure and unchanged balances. Transaction ${signature}`);
      }
      releaseClosure(round.address);
      return {
        market: m.address.toBase58(), propertyId: m.propertyId, order: order.address,
        rejected: true, roundNotOpen, signature, explorer: explorerTx(signature), feeLamports: meta.fee,
      };
    }
    throw unavailable(`Awaiting a finalized closure receipt for ${signature}`);
  }
  throw conflict("No resting sell order with a funded proof taker is available");
}

/**
 * Demo fast-forward (docs/spec-simulation.md §7): one request runs the whole lifecycle for one
 * round. It holds local workers off the round, then sends close_round and the oracle's
 * resolve_market in one confirmed transaction, so winning shares are redeemable within seconds.
 * Then it proves closure with a finalized rejected take, finalizes and publishes the evidence, and
 * sweeps. It advances the lifecycle only: the oracle alone decides YES, NO or Invalid from the
 * dataset whose hash the round committed. Makers and simulated traders redeem on their next tick.
 */
async function fastForward(round: RoundView) {
  if (operationRunning() || fullResetHeld()) throw conflict("A demo reset is in progress");
  const rpc = getRpc();
  const t0 = Date.now();
  const steps: SettleStep[] = [];
  const timings: Record<string, number> = {};
  let proof: Awaited<ReturnType<typeof proveRejected>> | null = null;
  let proofNote: string | null = null;
  if (round.status === "open") {
    holdClosure(round.address);
    try {
      const r = await closeAndResolve(round.address);
      timings.redeemableMs = Date.now() - t0;
      steps.push({ step: "close", target: round.address.toBase58(), signature: r.signature, note: `with oracle resolution of ${r.resolved} market (confirmed)` });
      const closed = await waitFinalizedClosed(round.address);
      timings.finalizedMs = Date.now() - t0;
      try {
        proof = await proveRejected(closed);
      } catch (e) {
        // The program rejects trades on a Closed round regardless; the proof is a demonstration.
        proofNote = e instanceof Error ? e.message : String(e);
      }
    } finally {
      releaseClosure(round.address);
    }
  }
  steps.push(
    ...(await settleRound(round.address, {
      rpc,
      controller: loadKeypair("controller"),
      oracle: loadKeypair("oracle"),
      keeper: loadKeypair("keeper"),
    })).filter((s) => !(s.step === "skip" && s.note === "already closed" && steps.some((x) => x.step === "close"))),
  );
  timings.totalMs = Date.now() - t0;
  const after = await rpc.run((c) => fetchRound(getExchangeProgram(c), round.address, "finalized"));
  return {
    action: "fast_forward",
    steps: withLinks(steps),
    proof,
    proofNote,
    timings,
    status: after ? await status(after) : null,
  };
}

export function handleOperatorSettle(req: Request): Promise<Response> {
  return (async () => {
    try {
      let body: { action?: unknown; round?: unknown; market?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        throw badRequest("Body must be JSON: { action, round?, market? }");
      }
      const action = body.action as OperatorAction;
      if (!OPERATOR_ACTIONS.includes(action)) throw badRequest(`action must be one of ${OPERATOR_ACTIONS.join(", ")}`);
      const round = await targetRound(body);
      if (body.market !== undefined && action !== "fast_forward" && action !== "status") throw badRequest("market applies to fast_forward and status only");
      await requireSoleMarket(round, body.market);
      if (action === "status") return json(await status(round));
      return json(
        await lock.with(round.address.toBase58(), async () => {
          const rpc = getRpc();
          if (action === "close") {
            if (round.status === "closed") return { action, steps: withLinks([{ step: "skip", target: round.address.toBase58(), signature: null, note: "already closed" }]) };
            holdClosure(round.address);
            const controller = loadKeypair("controller");
            const sig = await sendExchangeTx(rpc.connection, [await closeRoundIx(getExchangeProgram(rpc.connection), controller.publicKey, round.address)], [controller], {
              commitment: "finalized",
            });
            return { action, steps: withLinks([{ step: "close", target: round.address.toBase58(), signature: sig }]) };
          }
          if (action === "fast_forward") return fastForward(round);
          if (round.status !== "closed") throw conflict("Close the round first");
          if (action === "reject") return proveRejected(round);
          const steps = await settleRound(round.address, {
            rpc,
            controller: loadKeypair("controller"),
            oracle: loadKeypair("oracle"),
            keeper: action === "sweep" ? loadKeypair("keeper") : undefined,
          });
          return { action, steps: withLinks(action === "sweep" ? steps.filter((s) => s.step === "sweep") : steps) };
        }),
      );
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      // Failed submissions can include signed instruction data and simulation logs.
      console.error("[api] operator step failed:", e instanceof Error ? e.message : String(e));
      return json({ error: "Step failed. Read the round state and retry.", code: "step_failed" }, 502);
    }
  })();
}

