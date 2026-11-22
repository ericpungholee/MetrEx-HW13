// Keeper and sole writer of the finalized trade journal. The API reads that journal
// directly. The keeper loop and trade ingestion have independent RPC budgets.
import { setTimeout as delay } from "node:timers/promises";
import {
  connectionTradeSource,
  envOrUndefined,
  exchangeProgramId,
  getRpc,
  Keeper,
  loadKeypair,
  lockWorker,
  redactUrl,
  RpcPool,
  surviveTransientRpcErrors,
  tradeDecoder,
  TradeIndex,
  TradeStore,
  tradeStorePath,
  writeHeartbeat,
} from "@metrex/server/exchange";

async function main(): Promise<void> {
  if (envOrUndefined("METREX_ORACLE_DATA_DIR")) {
    throw new Error("METREX_ORACLE_DATA_DIR is set. The keeper never has access to settlement data (spec-v2 §8.4).");
  }
  surviveTransientRpcErrors("keeper");
  const pollMs = Number(envOrUndefined("KEEPER_POLL_MS") ?? 2_000);
  const disabled = envOrUndefined("KEEPER_DISABLED") === "1";
  const rpc = getRpc();
  const program = exchangeProgramId();
  const keeperKey = loadKeypair("keeper");
  const journal = tradeStorePath(program.toBase58());
  const unlock = await lockWorker(program, [keeperKey.publicKey, journal]);
  const keeper = new Keeper({ rpc, keeper: keeperKey });
  const indexRpc = new RpcPool(rpc.endpoints.map((c) => c.rpcEndpoint), "finalized", {
    maxRps: Number(envOrUndefined("INDEX_MAX_RPS") ?? 3),
    disableRetryOnRateLimit: true,
  });
  const indexMs = Number(envOrUndefined("INDEX_POLL_MS") ?? 1_500);
  const store = new TradeStore(journal, tradeDecoder(indexRpc), true);
  const index = new TradeIndex(connectionTradeSource(indexRpc, program), store);
  const stream = indexRpc.connection;
  const subscription = stream.onLogs(program, (event, ctx) => {
    if (!event.err) index.observe(event.signature, ctx.slot, event.logs);
  }, "finalized");
  let lastReport = Date.now();
  console.log(`[keeper] program ${program} rpc ${rpc.endpoints.map((c) => redactUrl(c.rpcEndpoint)).join(", ")}`);
  console.log(`[keeper] key ${keeperKey.publicKey} poll ${pollMs} ms${disabled ? " (matching disabled)" : ""}`);

  let stopping = false;
  const shutdown = new AbortController();
  const stop = () => { stopping = true; shutdown.abort(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const wait = (ms: number) => delay(Math.max(0, ms), undefined, { signal: shutdown.signal }).catch(() => undefined);
  let lastIndexError: string | null = null;
  const indexing = (async () => {
    while (!stopping) {
      const started = Date.now();
      try {
        await index.refresh();
        lastIndexError = null;
      } catch (e) {
        lastIndexError = (e as Error).message;
        console.log(`[indexer] refresh failed: ${lastIndexError}`);
      }
      await wait(lastIndexError ? 2 * indexMs : indexMs - (Date.now() - started));
    }
  })();

  while (!stopping) {
    const started = Date.now();
    if (started - lastReport >= 60_000) {
      console.log(`[keeper] rpc ${rpc.pacer.report()}`);
      console.log(`[indexer] rpc ${indexRpc.pacer.report()}`);
      lastReport = started;
    }
    let lastError: string | null = null;
    try {
      if (!disabled) await keeper.tick();
    } catch (e) {
      lastError = (e as Error).message;
      console.log(`[keeper] tick failed: ${lastError}`);
    }
    try {
      writeHeartbeat("keeper", {
        matching: !disabled,
        ticks: keeper.stats.ticks,
        matches: keeper.stats.matches,
        sweeps: keeper.stats.sweeps,
        failures: keeper.stats.failures,
        indexedTransactions: store.known.size,
        pendingTransactions: store.pending.size,
        backfilled: store.backfilled,
        indexDiscovered: index.discovered,
        indexStreamed: index.streamed,
        indexFetched: index.fetched,
        lastIndexAt: index.lastRefresh ? new Date(index.lastRefresh).toISOString() : null,
        lastIndexError,
        lastSignature: keeper.stats.lastSignature,
        lastError: lastError ?? keeper.stats.lastError,
      });
    } catch {
      /* heartbeat is best-effort */
    }
    await wait(pollMs - (Date.now() - started));
  }
  await indexing;
  await stream.removeOnLogsListener(subscription);
  unlock();
  console.log("[keeper] stopped");
}

main().catch((e: unknown) => {
  console.error(`[keeper] fatal: ${(e as Error).message}`);
  process.exit(1);
});
