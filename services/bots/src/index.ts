// Underwriter bot worker (spec §7, §7.1). `pnpm --filter bots start`.
// BOTS_TIER2=1 enables requoting and Risk-side listings (off by default).

import { envOrUndefined, getRpc, loadKeypair, musdMint, programId, redactUrl } from "@metrex/server";
import { BOTS, DEFAULT_LISTING_PREMIUM_PCT } from "./params";
import { BotWorker, type BotRuntime } from "./worker";

function intEnv(name: string, fallback: number): number {
  const v = envOrUndefined(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

async function main(): Promise<void> {
  const tier2 = envOrUndefined("BOTS_TIER2") === "1";
  const pollMs = intEnv("BOTS_POLL_MS", 3000);
  const listingPremiumPct = BigInt(intEnv("BOTS_LISTING_PREMIUM_PCT", Number(DEFAULT_LISTING_PREMIUM_PCT)));
  const rpc = getRpc();
  const mint = musdMint();
  const bots: BotRuntime[] = BOTS.map((params) => ({
    params,
    keypair: loadKeypair(params.keypair),
    inFlight: new Map(),
    lastSkip: new Map(),
  }));

  console.log(`[bots] program ${programId().toBase58()} rpc ${rpc.endpoints.map((c) => redactUrl(c.rpcEndpoint)).join(", ")}`);
  console.log(`[bots] mint ${mint.toBase58()} poll ${pollMs} ms tier2 ${tier2 ? "ON" : "off"}`);
  for (const b of bots) console.log(`[bots] ${b.params.name}: ${b.keypair.publicKey.toBase58()}`);

  const worker = new BotWorker({ rpc, mint, bots, tier2, listingPremiumPct });

  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = (sig: string) => {
    if (stopping) process.exit(1); // second signal: force
    stopping = true;
    console.log(`[bots] ${sig}: finishing current tick, then exiting`);
    wake?.();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopping) {
    const started = Date.now();
    try {
      await worker.tick();
    } catch (e) {
      console.log(`[bots] tick failed: ${(e as Error).message}`);
    }
    const wait = Math.max(0, pollMs - (Date.now() - started));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }
  console.log("[bots] stopped");
}

main().catch((e: unknown) => {
  console.error(`[bots] fatal: ${(e as Error).message}`);
  process.exit(1);
});
