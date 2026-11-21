// POST /api/rpc: the browser's JSON-RPC endpoint. Forwards an allowlist of methods to the server's
// RPC_URL (with RPC_URL_BACKUP on transport failure), so a provider API key never reaches the
// browser. Exchange account scans are not forwarded: wallets read their orders from GET /api/orders,
// which is served from the shared cached state. The frozen v1 fallback app (/v1) reads its markets
// with getProgramAccounts, so scans of the v1 program alone are forwarded, under the server's scan
// pacing. Every forwarded call is paced like the server's own (RPC_MAX_RPS / RPC_MAX_SCAN_RPS).

import { getRpc, isTransportError } from "../rpc";

/** The v1.1 program (frozen); the only program whose accounts the proxy may scan. */
export const V1_PROGRAM_ID = process.env.METREX_V1_PROGRAM_ID || "AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X";

export const RPC_PROXY_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getTokenAccountBalance",
  "getLatestBlockhash",
  "isBlockhashValid",
  "getBlockHeight",
  "getSlot",
  "getEpochInfo",
  "getSignatureStatuses",
  "getTransaction",
  "sendTransaction",
  "simulateTransaction",
  "getFeeForMessage",
  "getMinimumBalanceForRentExemption",
  "getRecentPrioritizationFees",
  "getGenesisHash",
  "getVersion",
  "getHealth",
]);

const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH = 20;

const reply = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** The methods of a JSON-RPC request or batch, or an error message. */
export function rpcMethods(body: unknown, scanPrograms: ReadonlySet<string> = new Set([V1_PROGRAM_ID])): string[] | string {
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length === 0 || calls.length > MAX_BATCH) return "batch size";
  const out: string[] = [];
  for (const c of calls) {
    const call = c as { method?: unknown; params?: unknown } | null;
    const m = call?.method;
    if (typeof m !== "string") return "missing method";
    if (m === "getProgramAccounts") {
      const target = Array.isArray(call?.params) ? (call.params as unknown[])[0] : undefined;
      if (typeof target !== "string" || !scanPrograms.has(target)) return "getProgramAccounts is only allowed for the v1 program";
    } else if (!RPC_PROXY_METHODS.has(m)) return `method not allowed: ${m}`;
    out.push(m);
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function handleRpcProxy(req: Request): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return reply(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "request too large" } });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reply(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  const methods = rpcMethods(body);
  if (typeof methods === "string") return reply(403, { jsonrpc: "2.0", id: null, error: { code: -32601, message: methods } });

  const pool = getRpc();
  const scans = methods.filter((m) => m === "getProgramAccounts").length;
  let wait = pool.pacer.reserve();
  for (let i = 0; i < scans; i++) wait = Math.max(wait, pool.scanPacer.reserve());
  if (wait > 0) await sleep(wait);

  const urls = pool.endpoints.map((c) => c.rpcEndpoint);
  let last: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: text });
      // A send is never retried on another endpoint: it may already have landed.
      if (res.status >= 500 && !methods.includes("sendTransaction") && url !== urls[urls.length - 1]) continue;
      return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (e) {
      last = e;
      if (methods.includes("sendTransaction") || !isTransportError(e)) break;
    }
  }
  console.error("[api] rpc proxy failed:", last instanceof Error ? last.message : String(last));
  return reply(502, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "RPC unavailable" } });
}
