// Framework-agnostic HTTP glue (standard Request/Response). The Next.js route files in
// app/app/api/** are one-liners over these, so this layer is unit-testable.

import type { PublicKey } from "@solana/web3.js";
import { getEvidence, getSettledPerimeter, type EvidenceDeps } from "../oracle/evidence";
import { resolveMarket } from "../oracle/resolve";
import { closeMarket } from "./close";
import { badRequest, unavailable } from "./errors";
import { json, run, requirePassword, marketParam } from "./http";

const NO_STORE = { "cache-control": "no-store" } as const;

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

/**
 * GET /api/evidence/:market → { market, canonical, hashHex, record, onChain }.
 * `?raw=1` returns the canonical file bytes exactly as hashed.
 * `?overlay=1` returns the verified historical map layer for an exchange market.
 */
export function handleEvidence(req: Request, market: string | undefined, deps?: EvidenceDeps): Promise<Response> {
  return run(async () => {
    const pk = marketParam(market);
    const params = new URL(req.url).searchParams;
    if (params.get("perimeter") === "1") return json(await getSettledPerimeter(pk, deps));
    const raw = params.get("raw") === "1";
    const ev = await getEvidence(pk, deps);
    if (raw) {
      return new Response(ev.canonical, {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8", "x-evidence-sha256": ev.hashHex, ...NO_STORE },
      });
    }
    return json(ev);
  });
}
