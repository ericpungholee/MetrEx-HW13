// GET /api/homes?hazard= — the homeowner address pool and its markets (docs/spec-multiperil.md §7.7).
import { handleHomes } from "@metrex/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request): Promise<Response> {
  return handleHomes(req);
}
