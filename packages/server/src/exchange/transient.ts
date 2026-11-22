// Long-running workers (bots, keeper and indexer, simulator) rebuild their state from the chain
// every tick, so a transient RPC failure that escapes as an unhandled rejection (web3.js
// confirmation polling can reject after the caller moved on) must not stop the whole demo
// (docs/spec-simulation.md §9). Anything else still exits.

const TRANSIENT = /^(429|5\d\d)\b|Too Many Requests|Service Unavailable|Bad Gateway|Gateway Time-?out|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|other side closed/i;

/** True when an error is a provider or network hiccup rather than a program or logic failure. */
export function isTransientRpcError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return TRANSIENT.test(message);
}

/** Logs transient unhandled rejections and keeps the worker alive; other rejections exit with status 1. */
export function surviveTransientRpcErrors(name: string): void {
  process.on("unhandledRejection", (e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (isTransientRpcError(e)) {
      console.warn(`[${name}] transient RPC error ignored: ${message.slice(0, 200)}`);
      return;
    }
    console.error(`[${name}] unhandled rejection: ${message}`);
    process.exit(1);
  });
}
