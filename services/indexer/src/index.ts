// Program transaction stats for the network panel (spec §10.5), standalone.
// The aggregation + cache live in @metrex/server (getStats), shared with GET /api/stats.
//   pnpm --filter indexer start            # print once
//   pnpm --filter indexer start -- --watch # print every 10 s

import { getIndexer } from "@metrex/server";

async function printOnce(): Promise<void> {
  const s = await getIndexer().getStats();
  console.log(
    `${s.updatedAt} program ${s.programId}: ${s.totalTransactions} txs (${s.last10Minutes} in last 10 min, ` +
      `${s.failedTransactions} failed), fees ${s.totalFeesSol} SOL` +
      (s.feesPending ? ` (+${s.feesPending} pending)` : "") +
      (s.truncated ? " [history truncated]" : "") +
      (s.stale ? " [stale]" : ""),
  );
}

async function main(): Promise<void> {
  const watch = process.argv.includes("--watch");
  await printOnce();
  if (!watch) return;
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    await new Promise((r) => setTimeout(r, 10_000));
    if (!stopping) await printOnce().catch((e: unknown) => console.log(`stats error: ${(e as Error).message}`));
  }
}

main().catch((e: unknown) => {
  console.error(`[indexer] fatal: ${(e as Error).message}`);
  process.exit(1);
});
