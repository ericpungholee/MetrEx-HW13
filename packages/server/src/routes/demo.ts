// GET/POST /api/operator/demo (docs/spec-simulation.md §9). GET is a public status read (every
// figure is on-chain or a worker heartbeat; no secrets). POST requires the demo password and runs
// one operator action: pause or resume the simulated traders, reset one market, reset the demo,
// or resume an interrupted operation. The oracle alone decides every settlement outcome.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey, type AccountInfo } from "@solana/web3.js";
import { CATALOG } from "@metrex/exchange";
import { ataOf, fetchRound } from "../exchange/accounts";
import { tokenAmountOf } from "../exchange/book";
import { readHeartbeat } from "../exchange/heartbeat";
import { DEMO_TRADING_HOURS, fullResetHeld, setSimulationPaused, simulationPaused } from "../exchange/demo-state";
import { getExchangeProgram } from "../exchange/program";
import { keyDir, loadKeypair, parsePublicKey, type KeypairName } from "../env";
import { getRpc } from "../rpc";
import { musdMint } from "../token";
import { currentOperation, operationRunning, startOperation } from "../demo/operations";
import { featuredRounds } from "../demo/lifecycle";
import { badRequest, conflict, HttpError, notFound } from "./errors";
import { json, requirePassword } from "./http";

export const DEMO_ACTIONS = ["pause_sim", "resume_sim", "reset_market", "reset_demo", "resume_operation"] as const;
export type DemoAction = (typeof DEMO_ACTIONS)[number];

const WALLETS: readonly KeypairName[] = ["deployer", "controller", "oracle", "keeper", "faucet", "simSponsor", "botA", "botB", "botC"];
const SOL_FLOORS: Partial<Record<KeypairName, bigint>> = {
  deployer: 1_000_000_000n, controller: 50_000_000n, oracle: 50_000_000n, keeper: 100_000_000n,
  faucet: 1_000_000_000n, simSponsor: 300_000_000n, botA: 300_000_000n, botB: 300_000_000n, botC: 300_000_000n,
};

let fundingCache: { at: number; value: unknown } | null = null;

async function funding() {
  if (fundingCache && Date.now() - fundingCache.at < 20_000) return fundingCache.value;
  const rpc = getRpc();
  const mint = musdMint();
  const named = WALLETS.flatMap((name) => {
    try {
      return [{ name, key: loadKeypair(name).publicKey }];
    } catch {
      return [];
    }
  });
  let sim: Array<{ address: string }> = [];
  try {
    sim = JSON.parse(readFileSync(join(keyDir(), "sim", "population.json"), "utf8")) as Array<{ address: string }>;
  } catch {
    sim = [];
  }
  const keys = [...named.flatMap((w) => [w.key, ataOf(mint, w.key)]), ...sim.flatMap((s) => [new PublicKey(s.address), ataOf(mint, new PublicKey(s.address))])];
  const infos: Array<AccountInfo<Buffer> | null> = [];
  for (let i = 0; i < keys.length; i += 100) infos.push(...(await rpc.run((c) => c.getMultipleAccountsInfo(keys.slice(i, i + 100), "confirmed"))));
  const wallets = named.map((w, i) => {
    const lamports = BigInt(infos[2 * i]?.lamports ?? 0);
    const floor = SOL_FLOORS[w.name] ?? 0n;
    return { name: w.name, address: w.key.toBase58(), lamports: lamports.toString(), musd: tokenAmountOf(infos[2 * i + 1]).toString(), low: lamports < floor };
  });
  const base = named.length * 2;
  let simLamports = 0n;
  let simMusd = 0n;
  sim.forEach((_, j) => {
    simLamports += BigInt(infos[base + 2 * j]?.lamports ?? 0);
    simMusd += tokenAmountOf(infos[base + 2 * j + 1]);
  });
  const value = { wallets, sim: { traders: sim.length, lamports: simLamports.toString(), musd: simMusd.toString() } };
  fundingCache = { at: Date.now(), value };
  return value;
}

async function demoStatus() {
  const rounds = await featuredRounds();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const op = currentOperation();
  const hb = (name: "bots" | "keeper" | "sim") => {
    const r = readHeartbeat(name);
    return { alive: r.alive, ageMs: r.ageMs, status: r.heartbeat?.status ?? null };
  };
  return {
    simulationPaused: simulationPaused(),
    fullResetHeld: fullResetHeld(),
    operation: op ? { ...op, running: operationRunning() } : null,
    workers: { bots: hb("bots"), keeper: hb("keeper"), sim: hb("sim") },
    rounds: CATALOG.map((c) => {
      const r = rounds.get(c.scenarioId);
      return {
        hazard: c.hazard,
        scenarioId: c.scenarioId,
        round: r?.address.toBase58() ?? null,
        roundId: r?.roundId.toString() ?? null,
        status: r?.status ?? null,
        tradingEndsAt: r?.tradingEndsAt.toString() ?? null,
        remainingS: r && r.status === "open" ? (r.tradingEndsAt > now ? (r.tradingEndsAt - now).toString() : "0") : null,
        resolvedCount: r?.resolvedCount ?? null,
        marketCount: r?.marketCount ?? null,
      };
    }),
    funding: await funding().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
  };
}

export function handleDemoStatus(): Promise<Response> {
  return (async () => {
    try {
      return json(await demoStatus());
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      console.error("[api] demo status failed:", e instanceof Error ? e.message : String(e));
      return json({ error: "Demo status unavailable", code: "unavailable" }, 503);
    }
  })();
}

export function handleDemoAction(req: Request): Promise<Response> {
  return (async () => {
    try {
      requirePassword(req);
      let body: { action?: unknown; round?: unknown; durationS?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        throw badRequest("Body must be JSON: { action, round? }");
      }
      const action = body.action as DemoAction;
      if (!DEMO_ACTIONS.includes(action)) throw badRequest(`action must be one of ${DEMO_ACTIONS.join(", ")}`);
      if (action === "pause_sim" || action === "resume_sim") {
        // Pausing stops simulated trading only. Deadlines are on-chain and never change.
        setSimulationPaused(action === "pause_sim");
        return json({ action, simulationPaused: simulationPaused() });
      }
      if (action === "resume_operation") {
        const op = currentOperation();
        if (!op || op.completed) throw conflict("Nothing to resume");
        return json({ action, operation: startOperation(op.action as "reset_market" | "reset_demo", op.rounds, { resume: true }) }, 202);
      }
      if (action === "reset_demo") return json({ action, operation: startOperation("reset_demo", []) }, 202);
      if (typeof body.round !== "string") throw badRequest("Select a round");
      let address: PublicKey;
      try {
        address = parsePublicKey(body.round, "round");
      } catch {
        throw badRequest("Invalid round address");
      }
      const round = await getRpc().run((c) => fetchRound(getExchangeProgram(c), address, "confirmed"));
      if (!round) throw notFound("Round not found");
      const featured = await featuredRounds();
      if (!featured.get(round.scenarioId)?.address.equals(round.address)) throw conflict("Only the current catalog round of a hazard can be reset");
      // Rehearsal only (accelerated natural expiry): a shorter window, never from the operator page.
      let durationS: bigint | undefined;
      if (body.durationS !== undefined) {
        if (typeof body.durationS !== "number" || !Number.isInteger(body.durationS) || body.durationS < 120 || body.durationS > DEMO_TRADING_HOURS * 3600) {
          throw badRequest(`durationS must be an integer from 120 to ${DEMO_TRADING_HOURS * 3600}`);
        }
        durationS = BigInt(body.durationS);
      }
      return json({ action, operation: startOperation("reset_market", [round.address.toBase58()], { durationS }) }, 202);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      console.error("[api] demo action failed:", e instanceof Error ? e.message : String(e));
      return json({ error: "Action failed. Read the demo status and retry.", code: "step_failed" }, 502);
    }
  })();
}
