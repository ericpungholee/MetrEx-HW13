// Market simulation worker (docs/spec-simulation.md). `pnpm --filter sim start`.
//   SIM_TRADERS        how many of the population trade (default 20; ramp 20 → 50 → 100)
//   SIM_SEED           population and bulletin seed (default "metrex-v7"; must match provisioning)
//   SIM_RATE           activity multiplier on every trader (default 1)
//   SIM_POLL_MS        tick interval (default 3000)
//   SIM_MAX_IN_FLIGHT  concurrent transactions (default 6)
//   RPC_MAX_RPS        client-side request cap for this process

import { envOrUndefined, exchangeProgramId, getRpc, loadKeypair, lockWorker, redactUrl, surviveTransientRpcErrors } from "@metrex/server/exchange";
import { assertNoOracleData } from "./guard";
import { loadTrader } from "./keys";
import { ARCHETYPE_LABEL, generatePopulation } from "./population";
import { SimWorker, type SimTrader } from "./worker";

function numEnv(name: string, fallback: number): number {
  const v = envOrUndefined(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

async function main(): Promise<void> {
  assertNoOracleData(); // exit before touching anything else
  surviveTransientRpcErrors("sim");
  const seed = envOrUndefined("SIM_SEED") ?? "metrex-v7";
  const count = Math.min(100, Math.floor(numEnv("SIM_TRADERS", 20)));
  const pollMs = numEnv("SIM_POLL_MS", 3_000);
  const rpc = getRpc();
  const sponsor = loadKeypair("simSponsor");
  const traders: SimTrader[] = generatePopulation(seed, 100)
    .slice(0, count)
    .map((profile) => ({ profile, keypair: loadTrader(profile.index), memory: new Map() }));
  const unlock = await lockWorker(exchangeProgramId(), [sponsor.publicKey, ...traders.map((t) => t.keypair.publicKey)]);
  console.log(`[sim] program ${exchangeProgramId().toBase58()} rpc ${rpc.endpoints.map((c) => redactUrl(c.rpcEndpoint)).join(", ")}`);
  console.log(`[sim] ${traders.length} simulated traders, seed ${seed}, sponsor ${sponsor.publicKey.toBase58()}`);
  const mix = new Map<string, number>();
  for (const t of traders) mix.set(ARCHETYPE_LABEL[t.profile.archetype], (mix.get(ARCHETYPE_LABEL[t.profile.archetype]) ?? 0) + 1);
  console.log(`[sim] mix: ${[...mix].map(([k, v]) => `${v} ${k}`).join(", ")}`);
  const worker = new SimWorker({ rpc, sponsor, traders, seed, rate: numEnv("SIM_RATE", 1), maxInFlight: Math.floor(numEnv("SIM_MAX_IN_FLIGHT", 6)) });

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[sim] ${sig}: finishing in-flight transactions, then exiting`);
    wake?.();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  let failedTicks = 0;
  while (!stopping) {
    const started = Date.now();
    try {
      await worker.tick();
      failedTicks = 0;
    } catch (e) {
      failedTicks++;
      console.log(`[sim] tick failed: ${(e as Error).message}`);
    }
    const wait = Math.max(0, Math.min(20_000, pollMs * 2 ** Math.min(failedTicks, 3)) - (Date.now() - started));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
  await worker.drain();
  unlock();
  console.log("[sim] stopped");
}

main().catch((e: unknown) => {
  console.error(`[sim] fatal: ${(e as Error).message}`);
  process.exit(1);
});
