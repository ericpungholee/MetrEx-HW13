// Exchange market-maker worker (spec-v2 §8). `pnpm --filter bots start`.
//   BOTS_POLL_MS          tick interval (default 2000)
//   BOTS_COOLDOWN_MS      per-bot, per-market requote cooldown (default 3000)
//   BOTS_SPLIT_PAIRS      pairs split when a side runs low (default 2000)
//   BOTS_FEATURED_PROPERTY featured property id, skew off there (default 1, §8.3)
//   BOTS_ADAPTIVE         0 = fixed catalog ladder; default adaptive references (docs/spec-simulation.md §3)
//   BOTS_ANCHOR_HALF_LIFE_MIN  reversion half-life toward the catalog reference (default 45)
//   RPC_MAX_RPS           client-side request cap for this process (unset = no cap); see docs/v2-build-log.md (V4, RPC rate limits)

import { DEFAULT_ADAPTIVE, DEMO_BOTS } from "@metrex/exchange";
import { envOrUndefined, exchangeProgramId, getRpc, loadKeypair, lockWorker, redactUrl, surviveTransientRpcErrors, type KeypairName } from "@metrex/server/exchange";
import { assertNoOracleData } from "./guard";
import { DEFAULT_BOT_CONFIG } from "./strategy";
import { ExchangeBotWorker, type V2Bot } from "./worker";

function intEnv(name: string, fallback: number): number {
  const v = envOrUndefined(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

const KEYS: Record<string, KeypairName> = { A: "botA", B: "botB", C: "botC" };

async function main(): Promise<void> {
  assertNoOracleData(); // §8.4: exit before touching anything else
  surviveTransientRpcErrors("bots");
  const pollMs = intEnv("BOTS_POLL_MS", 2_000);
  const config = {
    ...DEFAULT_BOT_CONFIG,
    cooldownMs: intEnv("BOTS_COOLDOWN_MS", 3_000),
    splitPairs: BigInt(intEnv("BOTS_SPLIT_PAIRS", Number(DEFAULT_BOT_CONFIG.splitPairs))),
    // docs/spec-simulation.md §3: four catalog markets with MAKER_CAPITAL per maker.
    inventoryMult: BigInt(intEnv("BOTS_INVENTORY_MULT", 4)),
  };
  const featuredPropertyId = intEnv("BOTS_FEATURED_PROPERTY", 1);
  const rpc = getRpc();
  const bots: V2Bot[] = DEMO_BOTS.map((params) => {
    const key = KEYS[params.name];
    if (!key) throw new Error(`no keypair for bot ${params.name}`);
    return { params, keypair: loadKeypair(key), lastAction: new Map() };
  });
  const unlock = await lockWorker(exchangeProgramId(), bots.map((bot) => bot.keypair.publicKey));
  console.log(`[bots v2] program ${exchangeProgramId().toBase58()} rpc ${rpc.endpoints.map((c) => redactUrl(c.rpcEndpoint)).join(", ")}`);
  console.log(`[bots v2] poll ${pollMs} ms, cooldown ${config.cooldownMs} ms, featured property ${featuredPropertyId}`);
  for (const b of bots) console.log(`[bots v2] MetrEx market maker ${b.params.name}: ${b.keypair.publicKey.toBase58()}`);

  const legacyRehearsal = envOrUndefined("BOTS_LEGACY_REHEARSAL") === "1";
  if (legacyRehearsal && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(rpc.connection.rpcEndpoint).hostname)) {
    throw new Error("The legacy ladder is for local validator rehearsals only");
  }
  const adaptive = envOrUndefined("BOTS_ADAPTIVE") !== "0";
  const adaptiveConfig = { ...DEFAULT_ADAPTIVE, anchorHalfLifeMin: intEnv("BOTS_ANCHOR_HALF_LIFE_MIN", DEFAULT_ADAPTIVE.anchorHalfLifeMin) };
  console.log(`[bots v2] ${adaptive ? `adaptive references, anchor half-life ${adaptiveConfig.anchorHalfLifeMin} min` : "fixed catalog ladder"}`);
  const worker = new ExchangeBotWorker({ rpc, bots, config, featuredPropertyId, legacyRehearsal, adaptive, adaptiveConfig });
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`[bots v2] ${sig}: finishing current tick, then exiting`);
    wake?.();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  let failedTicks = 0;
  let lastReport = Date.now();
  while (!stopping) {
    const started = Date.now();
    if (started - lastReport >= 60_000) {
      console.log(`[bots v2] rpc ${rpc.pacer.report()}`);
      lastReport = started;
    }
    try {
      await worker.tick();
      failedTicks = 0;
    } catch (e) {
      failedTicks++;
      console.log(`[bots v2] tick failed: ${(e as Error).message}`);
    }
    const wait = Math.max(0, Math.min(15_000, pollMs * 2 ** Math.min(failedTicks, 4)) - (Date.now() - started));
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
  console.log("[bots v2] stopped");
}

main().catch((e: unknown) => {
  console.error(`[bots v2] fatal: ${(e as Error).message}`);
  process.exit(1);
});
