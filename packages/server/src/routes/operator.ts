// POST /api/operator/settle-round (spec-v2 §10.6). The Close and settle workflow, one step per
// request so the operator page shows each verifiable transaction as it lands. Every step reads the
// chain first and skips what is already done, so the workflow can be resumed from any point.
// Requires the demo password header. Keys stay on the server.

import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { describeExchangeError, OrderSide, type OrderAccount } from "@metrex/exchange";
import { fetchExchangeConfig, fetchMarketsOfRound, fetchOrders, fetchRound, type RoundView } from "../exchange/accounts";
import { closeRoundIx, takeOrderIx } from "../exchange/ix";
import { getExchangeProgram } from "../exchange/program";
import { sendExchangeTx } from "../exchange";
import { loadKeypair, parsePublicKey, type KeypairName } from "../env";
import { explorerTx } from "../explorer";
import { settleRound, type SettleStep } from "../oracle/exchange-settle";
import { getRpc } from "../rpc";
import { badRequest, conflict, HttpError, KeyedLock, notFound, unavailable } from "./errors";
import { json, requirePassword } from "./http";

export const OPERATOR_ACTIONS = ["status", "close", "reject", "resolve", "sweep"] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

const BOT_KEYS: readonly KeypairName[] = ["botA", "botB", "botC"];
const lock = new KeyedLock();

const withLinks = (steps: SettleStep[]) => steps.map((s) => ({ ...s, explorer: s.signature ? explorerTx(s.signature) : null }));

async function targetRound(body: { round?: unknown }): Promise<RoundView> {
  const rpc = getRpc();
  let address: PublicKey;
  if (typeof body.round === "string" && body.round) {
    try {
      address = parsePublicKey(body.round, "round");
    } catch {
      throw badRequest("Invalid round address");
    }
  } else {
    const config = await rpc.run((c) => fetchExchangeConfig(getExchangeProgram(c), "finalized"));
    if (!config) throw unavailable("Exchange is not configured on this cluster");
    if (config.latestRound.equals(PublicKey.default)) throw notFound("No round yet");
    address = config.latestRound;
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

/**
 * §10.6 step 2: simulate a `take_order` against a resting order of the round and report the
 * program's answer. The taker is a market-maker bot other than the order's maker (it holds every
 * token account the instruction reads); signatures aren't verified in a simulation.
 */
async function proveRejected(round: RoundView) {
  const rpc = getRpc();
  const conn = rpc.connection;
  const p = getExchangeProgram(conn);
  const config = await rpc.run((c) => fetchExchangeConfig(getExchangeProgram(c)));
  if (!config) throw unavailable("Exchange is not configured on this cluster");
  const markets = await rpc.run((c) => fetchMarketsOfRound(p, round.address));
  const bots = BOT_KEYS.map((k) => loadKeypair(k).publicKey);
  for (const m of markets) {
    const orders = await rpc.run((c) => fetchOrders(getExchangeProgram(c), { market: m.address }));
    const order: OrderAccount | undefined = orders.find((o) => o.side === OrderSide.Sell && o.remainingQty > 0n) ?? orders[0];
    if (!order) continue;
    const taker = bots.find((b) => b.toBase58() !== order.maker);
    if (!taker) continue;
    const ix = await takeOrderIx(p, m, taker, config.collateralMint, order, 1n, order.side === OrderSide.Sell ? 9_999 : 1);
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: taker, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
    const logs = sim.value.logs ?? [];
    return {
      market: m.address.toBase58(),
      propertyId: m.propertyId,
      order: order.address,
      rejected: sim.value.err !== null,
      error: sim.value.err === null ? null : (describeExchangeError(logs) ?? JSON.stringify(sim.value.err)),
      roundNotOpen: logs.some((l) => /RoundNotOpen/.test(l)),
    };
  }
  return { market: null, propertyId: null, order: null, rejected: null, error: "No resting order left to test against", roundNotOpen: false };
}

export function handleOperatorSettle(req: Request): Promise<Response> {
  return (async () => {
    try {
      requirePassword(req);
      let body: { action?: unknown; round?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        throw badRequest("Body must be JSON: { action, round? }");
      }
      const action = body.action as OperatorAction;
      if (!OPERATOR_ACTIONS.includes(action)) throw badRequest(`action must be one of ${OPERATOR_ACTIONS.join(", ")}`);
      const round = await targetRound(body);
      if (action === "status") return json(await status(round));
      if (action === "reject") {
        if (round.status !== "closed") throw conflict("Close the round first");
        return json(await proveRejected(round));
      }
      return json(
        await lock.with(round.address.toBase58(), async () => {
          const rpc = getRpc();
          if (action === "close") {
            if (round.status === "closed") return { action, steps: withLinks([{ step: "skip", target: round.address.toBase58(), signature: null, note: "already closed" }]) };
            const controller = loadKeypair("controller");
            const sig = await sendExchangeTx(rpc.connection, [await closeRoundIx(getExchangeProgram(rpc.connection), controller.publicKey, round.address)], [controller], {
              commitment: "finalized",
            });
            return { action, steps: withLinks([{ step: "close", target: round.address.toBase58(), signature: sig }]) };
          }
          if (round.status !== "closed") throw conflict("Close the round first");
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

