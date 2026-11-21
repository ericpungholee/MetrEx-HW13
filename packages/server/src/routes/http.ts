// Framework-agnostic HTTP glue (standard Request/Response). The Next.js route files in
// app/app/api/** are one-liners over these, so this layer is unit-testable.

import type { PublicKey } from "@solana/web3.js";
import { parsePublicKey } from "../env";
import { getEvidence } from "../oracle/evidence";
import { resolveMarket } from "../oracle/resolve";
import { getStats } from "../stats";
import { TxError } from "../tx";
import { closeMarket } from "./close";
import { badRequest, forbidden, HttpError } from "./errors";
import { faucet } from "./faucet";
import { checkDemoPassword, DEMO_PASSWORD_HEADER } from "./password";

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

function requirePassword(req: Request): void {
  if (!process.env.DEMO_PASSWORD) throw forbidden("Demo controls are disabled (DEMO_PASSWORD unset)");
  if (!checkDemoPassword(req.headers.get(DEMO_PASSWORD_HEADER))) throw forbidden("Wrong or missing demo password");
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
    return json(await resolveMarket(marketParam(market)));
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
export function handleEvidence(req: Request, market: string | undefined): Promise<Response> {
  return run(async () => {
    const pk = marketParam(market);
    const raw = new URL(req.url).searchParams.get("raw") === "1";
    const ev = await getEvidence(pk, { skipChain: raw });
    if (raw) {
      return new Response(ev.canonical, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "x-evidence-sha256": ev.hashHex, ...NO_STORE },
      });
    }
    return json(ev);
  });
}

/** GET /api/stats */
export function handleStats(): Promise<Response> {
  return run(async () => json(await getStats()));
}
