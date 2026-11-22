// v2 exchange service (spec-v2 §7): keeper (§7.4), trade index refresh (§7.2) and heartbeat.
// Uses the dedicated `keeper` keypair (~/.config/metrex/keeper.json), which has no authority.
// Never reads settlement data: it imports only the oracle-free "@metrex/server/exchange" entry.
//   pnpm --filter indexer start
//   KEEPER_POLL_MS (default 2000)   KEEPER_DISABLED=1 (index + heartbeat only)
//   INDEX_POLL_MS (default 15000): the trade index here only feeds the heartbeat (the app keeps its
//   own), so it refreshes slowly and fetches at most 25 transactions per pass
//   RPC_MAX_RPS: client-side request cap for this process (unset = no cap)

import {
  envOrUndefined,
  exchangeProgramId,
  getExchangeProgram,
  getRpc,
  Keeper,
  loadKeypair,
  lockWorker,
  redactUrl,
  surviveTransientRpcErrors,
  TradeIndex,
  connectionTradeSource,
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
  const keeperKey = loadKeypair("keeper");
  const unlock = await lockWorker(exchangeProgramId(), [keeperKey.publicKey]);
  const keeper = new Keeper({ rpc, keeper: keeperKey });
  const indexMs = Number(envOrUndefined("INDEX_POLL_MS") ?? 15_000);
  const index = new TradeIndex(connectionTradeSource(() => rpc.connection, getExchangeProgram(rpc.connection).programId), { pageSize: 200, txPerRefresh: 25 });
  let lastIndex = 0;
  let lastReport = Date.now();
  console.log(`[keeper] program ${exchangeProgramId().toBase58()} rpc ${rpc.endpoints.map((c) => redactUrl(c.rpcEndpoint)).join(", ")}`);
  console.log(`[keeper] key ${keeperKey.publicKey.toBase58()} poll ${pollMs} ms${disabled ? " (matching disabled)" : ""}`);

  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  let lastError: string | null = null;
  while (!stopping) {
    const started = Date.now();
    if (started - lastReport >= 60_000) {
      console.log(`[keeper] rpc ${rpc.pacer.report()}`);
      lastReport = started;
    }
    try {
      if (!disabled) await keeper.tick();
      if (started - lastIndex >= indexMs) {
        lastIndex = started;
        await index.refresh();
      }
      lastError = null;
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
        indexedTransactions: index.size,
        lastSignature: keeper.stats.lastSignature,
        lastError: lastError ?? keeper.stats.lastError,
      });
    } catch {
      /* heartbeat is best-effort */
    }
    await new Promise((r) => setTimeout(r, Math.max(0, pollMs - (Date.now() - started))));
  }
  unlock();
  console.log("[keeper] stopped");
}

main().catch((e: unknown) => {
  console.error(`[keeper] fatal: ${(e as Error).message}`);
  process.exit(1);
});
