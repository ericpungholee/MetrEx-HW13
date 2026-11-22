// POST /api/operator/create-market { propertyId } (docs/spec-multiperil.md §7.7). No
// authentication, like the other demo operator routes: the server lists a listing property or a
// homeowner's house from the pinned home pool in its hazard's current round. Users never enter coordinates.

import { listMarket } from "../demo/lifecycle";
import { cachedCatalogRound, forgetState } from "./exchange";
import { badRequest, HttpError } from "./errors";
import { json } from "./http";

export function handleCreateMarket(req: Request): Promise<Response> {
  return (async () => {
    try {
      let body: { propertyId?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        throw badRequest("Body must be JSON: { propertyId }");
      }
      if (typeof body.propertyId !== "number" || !Number.isInteger(body.propertyId) || body.propertyId < 0 || body.propertyId > 65_535) throw badRequest("Select an address");
      const r = await listMarket(body.propertyId, cachedCatalogRound);
      if (r.signature) forgetState();
      return json({ round: r.round.toBase58(), market: r.market.toBase58(), signature: r.signature, created: r.signature !== null }, r.signature ? 201 : 200);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
      console.error("[api] create market failed:", e instanceof Error ? e.message : String(e));
      return json({ error: "Could not create the market. Try again.", code: "step_failed" }, 502);
    }
  })();
}
