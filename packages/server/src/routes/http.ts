// Framework-agnostic HTTP glue (standard Request/Response). The Next.js route files in
// app/app/api/** are one-liners over these, so this layer is unit-testable.

import type { PublicKey } from "@solana/web3.js";
import { exchangeProgramId } from "../exchange/program";
import { getExchangeEvidence, getExchangeSettledPerimeter } from "../oracle/exchange";
import { getRpc } from "../rpc";
import { parsePublicKey } from "../env";
import { getEvidence, getSettledPerimeter, type EvidenceDeps } from "../oracle/evidence";
import { resolveMarket } from "../oracle/resolve";
import { getStats } from "../stats";
import { TxError } from "../tx";
import { closeMarket } from "./close";
import { badRequest, forbidden, HttpError, tooMany, unavailable } from "./errors";
import { faucet } from "./faucet";
import { DEMO_PASSWORD_HEADER, OperatorPasswordBudget } from "./password";

const NO_STORE = { "cache-control": "no-store" } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...NO_STORE, ...headers },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
  if (e instanceof TxError) {
    return json({ error: e.message, code: "transaction_failed", signature: e.signature ?? null }, 502);
  }
  console.error("[api] unexpected error:", e instanceof Error ? e.message : String(e));
  return json({ error: "Internal error", code: "internal" }, 500);
}

function marketParam(value: string | undefined): PublicKey {
  try {
    return parsePublicKey(value ?? "", "market address");
  } catch {
    throw badRequest("Invalid market address");
  }
}

const operatorBudget = new OperatorPasswordBudget();

export function requirePassword(req: Request): void {
  const password = process.env.DEMO_PASSWORD;
  if (!password) throw forbidden("Demo controls are disabled (DEMO_PASSWORD unset)");
  const result = operatorBudget.check(req.headers.get(DEMO_PASSWORD_HEADER), password);
  if (result === "limited") throw tooMany("Too many operator authentication attempts. Retry in a minute.");
  if (result === "wrong") throw forbidden("Wrong or missing demo password");
}

async function run(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    return errorResponse(e);
  }
}

/** POST /api/demo/close/:market */
export function handleClose(req: Request, market: string | undefined): Promise<Response> {
  return run(async () => {
    requirePassword(req);
    return json(await closeMarket(marketParam(market)));
  });
}

/** POST /api/oracle/resolve/:market */
export function handleResolve(req: Request, market: string | undefined): Promise<Response> {
  return run(async () => {
    requirePassword(req);
    const key = marketParam(market);
    try {
      return json(await resolveMarket(key));
    } catch {
      // Failed submissions can include signed instruction data and simulation logs.
      throw unavailable("Settlement could not be verified. Check market status and retry.");
    }
  });
}

/** POST /api/faucet { wallet } */
export function handleFaucet(req: Request): Promise<Response> {
  return run(async () => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw badRequest("Body must be JSON: { wallet }");
    }
    const wallet = (body as { wallet?: unknown } | null)?.wallet;
    if (typeof wallet !== "string") throw badRequest("Missing wallet");
    let pk: PublicKey;
    try {
      pk = parsePublicKey(wallet, "wallet address");
    } catch {
      throw badRequest("Invalid wallet address");
    }
    return json(await faucet(pk));
  });
}

/**
 * GET /api/evidence/:market → { market, canonical, hashHex, record, onChain }.
 * `?raw=1` returns the canonical file bytes exactly as hashed.
 */
export function handleEvidence(req: Request, market: string | undefined, deps?: EvidenceDeps): Promise<Response> {
  return run(async () => {
    const pk = marketParam(market);
    const params = new URL(req.url).searchParams;
    const v2 = deps?.readMarket ? false : await isExchangeMarket(pk);
    if (params.get("perimeter") === "1") {
      return json(v2 ? await getExchangeSettledPerimeter(pk, { rpc: deps?.rpc, dataDir: deps?.dataDir }) : await getSettledPerimeter(pk, deps));
    }
    const raw = params.get("raw") === "1";
    const ev = v2 ? await getExchangeEvidence(pk, { rpc: deps?.rpc, dataDir: deps?.dataDir }) : await getEvidence(pk, deps);
    if (raw) {
      return new Response(ev.canonical, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "x-evidence-sha256": ev.hashHex, ...NO_STORE },
      });
    }
    return json(ev);
  });
}

/** Owner of an account never changes, so the v1/v2 dispatch is cached per address. */
const ownerIsExchange = new Map<string, boolean>();
async function isExchangeMarket(pk: PublicKey): Promise<boolean> {
  const k = pk.toBase58();
  const hit = ownerIsExchange.get(k);
  if (hit !== undefined) return hit;
  const info = await getRpc()
    .run((c) => c.getAccountInfo(pk, "confirmed"))
    .catch(() => {
      throw unavailable("Evidence temporarily unavailable");
    });
  if (!info) return false;
  const v2 = info.owner.equals(exchangeProgramId());
  ownerIsExchange.set(k, v2);
  return v2;
}

/** GET /api/stats */
export function handleStats(): Promise<Response> {
  return run(async () => {
    const stats = await getStats();
    return json({
      ...stats,
      txTotal: stats.totalTransactions,
      txLast10Min: stats.last10Minutes,
    });
  });
}
